import { createProxyMiddleware } from 'http-proxy-middleware';
import config from './config.js';

const graphQLProxy = createProxyMiddleware({
    target: `${config.guppyConfig.host}/graphql`,
    changeOrigin: true,
    on: {
    error: (err, req, res) => {
        res.status(500).send(err);
    },
    proxyReq: (proxyReq, req, res) => {
        if (req.body) {
            const bodyData = JSON.stringify(req.body);
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
        }
    },
    proxyRes: (proxyRes, req, res) => {},
    proxyReqWs: () => {},
    open: () => {},
    close: () => {},
    },
});

export default graphQLProxy;
