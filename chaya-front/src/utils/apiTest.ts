export const testApiKey = (): { hasKey: boolean; keyValue: string } => {
  const apiKey = import.meta.env.VITE_YOUTUBE_API_KEY;
  
  return {
    hasKey: !!apiKey && apiKey !== 'YOUR_API_KEY_HERE',
    keyValue: apiKey || 'Not set'
  };
};

export const getApiKeyStatus = (): string => {
  const { hasKey, keyValue } = testApiKey();
  
  if (!hasKey) {
    return 'API密钥未设置。请在 .env.local 文件中设置 VITE_YOUTUBE_API_KEY';
  }
  
  if (keyValue === 'YOUR_API_KEY_HERE') {
    return 'API密钥为默认值，请设置真实的YouTube API密钥';
  }
  
  return 'API密钥已设置';
}; 