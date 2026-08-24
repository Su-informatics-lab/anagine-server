# anagine-server

> [!NOTE]
> The Anagine services are maintained in this repo: https://github.com/Su-informatics-lab/ardac-anagine.

Express API and route handlers for the Anagine server service.

## Build

Build the production container from the repository root:

```sh
docker build -t anagine-server .
```

The container listens on port `3000` and starts with:

```text
node ./src/server/server.js
```

The server expects the Rserve and Python kernel services to be deployed
separately. Their default endpoints can be overridden with `RSERVE_HOST`,
`RSERVE_PORT`, and `PYKERNEL_URL`.

## Run

For a basic local startup check:

```sh
docker run --rm -p 3000:3000 anagine-server
```

Production deployments should also configure the Guppy, Arborist, and LLM
environment variables required by their environment.
