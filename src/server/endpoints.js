import { createProxyMiddleware } from 'http-proxy-middleware';
import config from './config.js';

export const statusProxy = createProxyMiddleware({
    target: `${config.guppyConfig.host}/_status`,
    changeOrigin: true,
})


export const versionProxy = createProxyMiddleware({
    target: `${config.guppyConfig.host}/_version`,
    changeOrigin: true,
})
