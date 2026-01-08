FROM denoland/deno:1.40.0

WORKDIR /app

COPY server.js .

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "server.js"]
