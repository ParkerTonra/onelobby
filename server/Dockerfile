# keepalive-server image. Build context is the server/ directory:
#   docker build -t ghcr.io/parkertonra/keepalive-server:latest server
# Not built in CI-less dev boxes without a Docker daemon; the Dockerfile is plain multi-stage .NET.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Directory.Build.props ./
COPY Keepalive.Server/Keepalive.Server.csproj Keepalive.Server/
RUN dotnet restore Keepalive.Server/Keepalive.Server.csproj
COPY Keepalive.Server/ Keepalive.Server/
RUN dotnet publish Keepalive.Server/Keepalive.Server.csproj -c Release -o /out --no-restore -p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out .
# Non-root; the stack's compose file runs the container read-only, the server writes nothing to disk.
USER $APP_UID
ENV DOTNET_EnableDiagnostics=0 \
    DOTNET_gcServer=0
EXPOSE 8080
# Listens on :8080, or on $PORT when the host sets it (Render, Railway, Heroku-style platforms).
# Flags (or KEEPALIVE_* env vars) are appended: --listen, --turn-urls, --turn-secret, --public-url, --allowed-games, --max-lobbies ...
ENTRYPOINT ["dotnet", "keepalive-server.dll"]
