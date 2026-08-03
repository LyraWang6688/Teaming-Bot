import type { NextConfig } from 'next';

const meetingAnalysisEnabled = process.env.NEXT_PUBLIC_MEETING_ANALYSIS_ENABLED === 'true';

const nextConfig: NextConfig = {
  devIndicators: false,
  async redirects() {
    if (meetingAnalysisEnabled) {
      return [];
    }

    return [
      {
        source: '/',
        destination: '/feishu-config',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
