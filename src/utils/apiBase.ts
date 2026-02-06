export const getApiBaseUrl = () => {
  if (process.env.NEXT_PUBLIC_USE_LOCAL_BACKEND === 'true') {
    return process.env.NEXT_PUBLIC_LOCAL_API_URL;
  }

  return process.env.NEXT_PUBLIC_PUBLIC_API_URL || 'https://api.quran.com';
};
