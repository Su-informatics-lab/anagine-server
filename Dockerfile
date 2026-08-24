# Bookworm includes R 4.2+, and apt prebuilt R packages are much faster than source builds
# security: node:18 is EOL (Apr 2025); upgraded to node:22 (LTS, EOL Apr 2027)
FROM node:22-bookworm

# --no-install-recommends significantly reduces image size and avoids disk pressure
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    r-base r-base-dev curl tini pandoc \
    texlive-latex-recommended texlive-fonts-recommended texlive-latex-extra texlive-xetex lmodern \
    r-cran-rmarkdown r-cran-knitr r-cran-jsonlite r-cran-dplyr r-cran-ggplot2 \
    r-cran-tinytex r-cran-tidyr r-cran-broom r-cran-dt && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --ignore-scripts


COPY . .
RUN npm run prepare

ENV RSCRIPT_PATH=/app/src/R/lm.R \
    REPORTS_DIR=/tmp/reports \
    ANAGINE_PORT=3000 \
    NODE_ENV=production \
    INTERNAL_LOCAL_TEST=false \
    ANAGINE_OLLAMA_HOST=http://ollama:11434 \
    ANAGINE_OLLAMA_MODEL=llama3.2:1b \
    ANAGINE_ES_HOST=http://elasticsearch:9200 \
    ANAGINE_GUPPY_HOST=http://guppy:3010

EXPOSE 3000

# security: run as non-root; the node image ships a built-in 'node' user (UID 1000)
USER node

ENTRYPOINT ["/usr/bin/tini","--"]

CMD ["node","./src/server/server.js"]
