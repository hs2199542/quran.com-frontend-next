// src/utils/apiBase.ts

const getApiBaseUrl = () => {
  // In the new architecture, the client should exclusively use the local proxy path
  // defined in NEXT_PUBLIC_API_BASE_URL (which we set to /api/proxy in Step 2).
  return process.env.NEXT_PUBLIC_API_BASE_URL || '/api/proxy';
};

// Satisfy 'Prefer default export on a file with single export'
export default getApiBaseUrl;
