import { NextApiRequest, NextApiResponse } from 'next';
import { EventEmitter } from 'events';
import { Readable } from 'stream'; // Import Readable stream utility

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

// --- Helper Functions from Original Code (Adjusted for fetch environment) ---

const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const { hostname } = url;
    return ALLOWED_DOMS.includes(hostname);
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

const attachSignatureHeaders = (req: NextApiRequest, headers: Headers) => {
  const requestUrl = `${process.env.API_GATEWAY_URL}${req.url}`;
  const { signature, timestamp } = generateSignature(
    req,
    requestUrl,
    process.env.SIGNATURE_TOKEN as string,
  );

  headers.set(X_AUTH_SIGNATURE, signature);
  headers.set(X_TIMESTAMP, timestamp);
  headers.set(X_INTERNAL_CLIENT, process.env.INTERNAL_CLIENT_ID || 'QDC_WEB');
};

// --- Custom Fetch Handler with Fallback Logic ---

const customFetch = async (
  req: NextApiRequest,
  res: NextApiResponse,
  targetHost: string,
  apiPath: string,
) => {
  const targetUrl = `${targetHost}${apiPath}`;
  
  // 1. Check Origin/Signature (Permission check from original handleProxyReq)
  const origin = req.headers.origin || req.headers.referer;
  if (origin && !isOriginAllowed(origin)) {
    res.status(403).json({ error: ERROR_MESSAGES.FORBIDDEN });
    throw new Error(ERROR_MESSAGES.FORBIDDEN);
  } else if (!origin && !verifySignature(req, res)) {
    // If signature verification fails, response was already sent by customFetch. Stop processing.
    throw new Error(ERROR_MESSAGES.FORBIDDEN);
  }

  // 2. Prepare Headers and Body
  const headers = new Headers();
  
  // Copy necessary incoming headers, excluding those managed by Next.js or problematic for fetch
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
  attachSignatureHeaders(req, headers);
  
  // Prepare body based on method
  let body: BodyInit | undefined = undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
      // If bodyParser is set to false (see config export), req.body is a stream/buffer
      // We must handle the raw body stream/buffer here, preserving the original content type
      // We read the body into a buffer and send it directly with fetch
      let rawBody = req.body;
      if (typeof rawBody === 'undefined' || rawBody === null) {
          // No body available
      } else if (Buffer.isBuffer(rawBody)) {
          body = rawBody;
      } else {
          // If body is already parsed (e.g., JSON), we stringify it back.
          // This path is less safe if you handle mixed content types/streams.
          body = JSON.stringify(rawBody);
          if (!headers.get('Content-Type')) {
            headers.set('Content-Type', 'application/json');
          }
      }
  }

  const options: RequestInit = {
    method: req.method,
    headers: headers,
    body: body,
  };

  // 3. Perform Fetch Request
  console.log(`[API Proxy] Trying: ${targetUrl}`);
  let response: Response;
  try {
    response = await fetch(targetUrl, options);
  } catch (e) {
    // Catch network/connection errors only
    const errorMessage = e instanceof Error ? e.message : 'Unknown network error';
    console.warn(`[API Proxy] Network error to ${targetHost}: ${errorMessage}`);
    throw new Error('NETWORK_FAILURE');
  }

  // 4. Handle Server Errors (5xx)
  if (response.status >= 500 && response.status <= 599) {
    console.warn(`[API Proxy] Server error (${response.status}) from ${targetHost}`);
    throw new Error('SERVER_ERROR');
  }

  // 5. Successful response (2xx, 3xx, or 4xx errors are forwarded to client)
  return response;
};

// --- Main Handler ---

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const path = req.query.path as string[];
  const apiPath = '/' + path.join('/');

  // Determine host based on path
  const isAuthEndpoint = apiPath.startsWith('/auth');

  const primaryHost = isAuthEndpoint ? AUTH_LOCAL_API_HOST : LOCAL_API_HOST;
  const fallbackHost = isAuthEndpoint ? AUTH_PUBLIC_API_HOST : PUBLIC_API_HOST;

  let finalResponse: Response | null = null;
  let primaryFailed = false;

  // 1. Attempt Primary Host
  if (primaryHost) {
    try {
      finalResponse = await customFetch(req, res, primaryHost, apiPath);
    } catch (e) {
      if (e instanceof Error && e.message === ERROR_MESSAGES.FORBIDDEN) {
        return; // Response already sent
      }
      primaryFailed = true;
      console.warn(`[API Proxy] Primary request failed to ${primaryHost}${apiPath}. Proceeding to fallback.`);
    }
  } else {
    primaryFailed = true;
  }
  
  // 2. Attempt Fallback Host if Primary Failed
  if (primaryFailed && fallbackHost) {
    try {
      finalResponse = await customFetch(req, res, fallbackHost, apiPath);
    } catch (e) {
      if (e instanceof Error && e.message === ERROR_MESSAGES.FORBIDDEN) {
        return; // Response already sent
      }
      console.error(`[API Proxy] Fallback request also failed to ${fallbackHost}${apiPath}.`);
    }
  }

  // 3. Send Final Response or Error
  if (finalResponse) {
    // Forward the status code and headers from the successful response
    res.status(finalResponse.status);

    finalResponse.headers.forEach((value, name) => {
        // Exclude headers that should be handled by Next.js or cause issues
        if (!['content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
            res.setHeader(name, value);
        }
    });

    // Handle cookies (Set-Cookie) manually
    const proxyCookies = finalResponse.headers.get('set-cookie');
    if (proxyCookies) {
      res.setHeader('Set-Cookie', proxyCookies);
    }

    // Set anti-caching headers (from original code)
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
  } else {
    // Both primary and fallback failed or were not configured
    res.status(503).json({ 
      error: ERROR_MESSAGES.SERVICE_UNAVAILABLE, 
      path: apiPath 
    });
  }
}

// Maximum request body size for API routes, aligned with backend limit for profile picture uploads
const API_BODY_SIZE_LIMIT = process.env.API_BODY_SIZE_LIMIT || '8mb';

export const config = {
  api: {
    // Setting bodyParser to false requires manual body handling in customFetch, 
    // but ensures compatibility with streaming and various content types.
    bodyParser: false,
    sizeLimit: API_BODY_SIZE_LIMIT,
    responseLimit: false,
  },
};
