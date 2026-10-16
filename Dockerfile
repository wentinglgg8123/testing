FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 LEDGER_HOST=0.0.0.0 LEDGER_DATA_DIR=/app/data
RUN install -d -o node -g node /app/data
COPY --chown=node:node package.json server.js backend.js ledger.js account.js app.js index.html styles.css ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
