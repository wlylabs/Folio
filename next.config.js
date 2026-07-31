/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        // Article mode used to be a tab above the launch form, on a public URL
        // that was in the sitemap. It is gone, and the launch form is all that
        // is left here — which is what a member of the public arriving on the
        // old URL wanted anyway: the way to publish something of their own.
        //
        // Permanent, because the removal is. A crawler that has /create/article
        // indexed should drop it and keep /create.
        source: "/create/article",
        destination: "/create",
        permanent: true,
      },
      {
        // The desk's own articles are gone, and with them the two URLs that
        // ever carried one: /read first, then /postfolio. There is nothing left
        // to point either of them at except the launchpad, which is now the
        // whole site — so both halves of both URLs land there rather than on a
        // 404 that tells a reader nothing about what happened.
        //
        // Permanent, because the removal is: a crawler holding any of these
        // should drop it.
        source: "/read",
        destination: "/",
        permanent: true,
      },
      {
        source: "/read/:slug",
        destination: "/",
        permanent: true,
      },
      {
        source: "/postfolio",
        destination: "/",
        permanent: true,
      },
      {
        source: "/postfolio/:slug",
        destination: "/",
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
