import { NextApiRequest, NextApiResponse } from 'next';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

import generateSignature from '@/utils/auth/signature';
import {
  X_AUTH_SIGNATURE,
  X_INTERNAL_CLIENT,
  X_TIMESTAMP,
  X_PROXY_SIGNATURE,
  X_PROXY_TIMESTAMP,
} from '@/utils/headers';

// Environment Variables for Fallback
const LOCAL_API_HOST = process.env.QURAN_API_HOST;
const AUTH_LOCAL_API_HOST = process.env.AUTH_API_HOST;
const PUBLIC_API_HOST = process.env.QURAN_PUBLIC_API_HOST || 'https://api.quran.com';
const AUTH_PUBLIC_API_HOST = process.env.AUTH_PUBLIC_API_HOST || 'https://api.quran.com';

const ERROR_MESSAGES = {
  PROXY_ERROR: 'Proxy error',
  FORBIDDEN: 'Forbidden',
  SERVICE_UNAVAILABLE: 'Service Unavailable. Could not connect to primary or fallback API endpoints.',
};

const ALLOWED_DOMAINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((domain) => domain.trim());

EventEmitter.defaultMaxListeners = Number(process.env.PROXY_DEFAULT_MAX_LISTENERS) || 100;

// --- Helper Functions for Security Checks ---

const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const { hostname } = url;
    return ALLOWED_DOMAINS.includes(hostname);
  } catch (e) {
    return false;
  }
};

const verifySignature = (req: NextApiRequest, res: NextApiResponse): boolean => {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const requestUrl = `${protocol}://${req.headers.host}/api/proxy${req.url}`;
  const timestampHeader = req.headers[X_PROXY_TIMESTAMP] as string;
  const { signature } = generateSignature(
    req,
    requestUrl,
    process.env.PROXY_SIGNATURE_TOKEN as string,
    timestampHeader,
  );

  if (req.headers[X_PROXY_SIGNATURE] !== signature) {
    res.status(403).json({ error: ERROR_MESSAGES.FORBIDDEN });
    return false;
  }
  return true;
};

const getRequestOptions = (req: NextApiRequest, rawBody: unknown) => {
  const headers = new Headers();

  // Copy incoming headers
  Object.keys(req.headers).forEach((key) => {
    const headerKey = key.toLowerCase();
    if (!['host', 'content-length', 'connection', 'accept-encoding'].includes(headerKey)) {
      const value = req.headers[key];
      if (value) {
        headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
    }
  });

  // Attach internal signature headers
  const requestUrl = `${process.env.API_GATEWAY_URL}${req.url}`;
  const { signature, timestamp } = generateSignature(
    req,
    requestUrl,
    process.env.SIGNATURE_TOKEN as string,
  );
  headers.set(X_AUTH_SIGNATURE, signature);
  headers.set(X_TIMESTAMP, timestamp);
  headers.set(X_INTERNAL_CLIENT, process.env.INTERNAL_CLIENT_ID || 'QDC_WEB');
  
  let body: BodyInit | undefined;
  
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (Buffer.isBuffer(rawBody)) {
      body = rawBody;
    } else if (rawBody) {
      body = JSON.stringify(rawBody);
      if (!headers.get('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
    }
  }

  return { method: req.method, headers, body };
};

// --- Custom Fetch Handler (Simplified for line count) ---

const customFetch = async (
  req: NextApiRequest,
  res: NextApiResponse,
  targetHost: string,
  apiPath: string,
) => {
  const targetUrl = `${targetHost}${apiPath}`;
  
  // Security check: If response is sent here (e.g., Forbidden), it throws.
  const origin = req.headers.origin || req.headers.referer;
  if (origin && !isOriginAllowed(origin)) {
    res.status(403).json({ error: ERROR_MESSAGES.FORBIDDEN });
    throw new Error(ERROR_MESSAGES.FORBIDDEN);
  } else if (!origin && !verifySignature(req, res)) {
    throw new Error(ERROR_MESSAGES.FORBIDDEN);
  }

  const options = getRequestOptions(req, req.body);

  // Perform Fetch Request
  console.log(`[API Proxy] Trying: ${targetUrl}`);
  let response: Response;
  try {
    response = await fetch(targetUrl, options);
  } catch (e) {
    console.warn(`[API Proxy] Network error to ${targetHost}`);
    throw new Error('NETWORK_FAILURE');
  }

  // Handle Server Errors (5xx)
  if (response.status >= 500 && response.status <= 599) {
    console.warn(`[API Proxy] Server error (${response.status}) from ${targetHost}`);
    throw new Error('SERVER_ERROR');
  }

  return response;
};

// --- Main Handler (Refactored for max-lines-per-function) ---

const handleSuccessfulResponse = (finalResponse: Response, res: NextApiResponse) => {
  res.status(finalResponse.status);

  finalResponse.headers.forEach((value, name) => {
    if (!['content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
      res.setHeader(name, value);
    }
  });

  const proxyCookies = finalResponse.headers.get('set-cookie');
  if (proxyCookies) {
    res.setHeader('Set-Cookie', proxyCookies);
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Convert Web Stream (from fetch) to Node Stream (for res.pipe)
  if (finalResponse.body) {
    // @ts-ignore
    Readable.fromWeb(finalResponse.body).pipe(res);
  } else {
    res.end();
  }
};


export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const path = req.query.path as string[];
  const apiPath = `/${path.join('/')}`;

  const isAuthEndpoint = apiPath.startsWith('/auth');

  const primaryHost = isAuthEndpoint ? AUTH_LOCAL_API_HOST : LOCAL_API_HOST;
  const fallbackHost = isAuthEndpoint ? AUTH_PUBLIC_API_HOST : PUBLIC_API_HOST;

  let finalResponse: Response | null = null;
  let primaryFailed = false;

  // 1. Attempt Primary Host (Max 15 lines)
  if (primaryHost) {
    try {
      finalResponse = await customFetch(req, res, primaryHost, apiPath);
    } catch (e) {
      if (e instanceof Error && e.message === ERROR_MESSAGES.FORBIDDEN) return;
      primaryFailed = true;
      console.warn(`[API Proxy] Primary request failed. Proceeding to fallback.`);
    }
  } else {
    primaryFailed = true;
  }
  
  // 2. Attempt Fallback Host (Max 15 lines)
  if (primaryFailed && fallbackHost) {
    try {
      finalResponse = await customFetch(req, res, fallbackHost, apiPath);
    } catch (e) {
      if (e instanceof Error && e.message === ERROR_MESSAGES.FORBIDDEN) return;
      console.error(`[API Proxy] Fallback request also failed.`);
    }
  }

  // 3. Send Response
  if (finalResponse) {
    handleSuccessfulResponse(finalResponse, res);
  } else {
    // Both primary and fallback failed or were not configured
    res.status(503).json({ 
      error: ERROR_MESSAGES.SERVICE_UNAVAILABLE, 
      path: apiPath 
    });
  }
}

const API_BODY_SIZE_LIMIT = process.env.API_BODY_SIZE_LIMIT || '8mb';

export const config = {
  api: {
    // Ensures req.body is treated as a raw stream/buffer for generic proxy handling
    bodyParser: false,
    sizeLimit: API_BODY_SIZE_LIMIT,
    responseLimit: false,
  },
};
