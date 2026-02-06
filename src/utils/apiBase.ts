// src/utils/apiBase.ts

const getApiBaseUrl = () => {
  return process.env.NEXT_PUBLIC_API_BASE_URL || '/api/proxy';
};

export default getApiBaseUrl;
