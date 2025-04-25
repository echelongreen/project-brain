/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@project-brain/api", "@project-brain/db"],
};
 
export default nextConfig; 