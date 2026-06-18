# AgentCore Runtime requires linux/arm64 images (Graviton).
# If you build for amd64 by accident, the container will fail with
# "exec format error" when AgentCore tries to start it.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:20

WORKDIR /app

# Copy package files first so Docker can cache the npm install layer
# (this layer only re-runs when package.json/package-lock.json change).
COPY package*.json ./

RUN npm install

# Now copy the rest of the source and build.
COPY . ./
RUN npm run build

# Document the port. AgentCore Runtime will route traffic here.
EXPOSE 8080

# Start the compiled JavaScript.
CMD ["npm", "start"]
