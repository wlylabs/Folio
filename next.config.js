/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        // Article mode used to be a tab above the launch form, on a public URL
        // that was in the sitemap. It is now the staff desk at /desk, behind a
        // password, so the old URL cannot simply point at it — the thing it
        // advertised is not the thing that is there. It goes to the launchpad
        // instead, which is what a member of the public arriving on it wanted:
        // the way to publish something of their own.
        //
        // Permanent, because the move is. A crawler that has /create/article
        // indexed should drop it and keep /create.
        source: "/create/article",
        destination: "/create",
        permanent: true,
      },
    ];
  },
  // No `images` config on purpose: nothing here uses next/image, and a
  // `hostname: "**"` remotePattern turns the optimizer into an open image
  // proxy for any host on the internet. Avatars render as plain <img>.
  webpack: (config) => {
    // RainbowKit pulls in Coinbase Smart Wallet's optional x402 payment
    // modules via @base-org/account. We don't use that connector, and
    // these packages aren't installed — tell webpack to skip them
    // instead of failing the build.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/evm/upto/client": false,
      "@x402/evm/exact/client": false,
      "@x402/core/client": false,
      "@x402/svm/exact/client": false,
      "@x402/evm": false,
      // MetaMask SDK's React Native storage and WalletConnect's optional
      // pretty-printer for pino. Neither applies to a browser build.
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };
    return config;
  },
};

module.exports = nextConfig;
