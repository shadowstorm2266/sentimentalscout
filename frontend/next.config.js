/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",          // static export — works perfectly on Vercel
  trailingSlash: true,
  images: { unoptimized: true },
};

module.exports = nextConfig;
