/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
