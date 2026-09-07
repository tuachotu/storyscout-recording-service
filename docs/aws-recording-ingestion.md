# AWS Recording Ingestion

The backend is a stateless Fastify container. The browser uploads audio directly to the private S3 bucket using a short-lived URL signed by the backend. Recording metadata is stored in S3 beside the audio.

## Runtime

- Run the container on App Runner or ECS Fargate with an IAM task/service role.
- Set the variables documented in `.env.example`; store `PARTICIPANTS_JSON` and `SESSION_SIGNING_SECRET` in the runtime secret/configuration service rather than the image.
- Route `/api/v1/health` for liveness and `/api/v1/ready` for readiness.
- Deploy the Vite `dist/` directory as static content behind CloudFront and set `VITE_STORYSCOUT_API_URL` at build time.

## Minimum IAM permissions

Restrict the runtime role to the bucket's `recordings/` prefix with `s3:GetObject`, `s3:PutObject`, and the minimal bucket-level permission needed for readiness. Keep S3 Block Public Access enabled.

## Required bucket CORS

Apply only after confirming every production hostname:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173", "http://127.0.0.1:5173", "https://vikrant.info"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type", "x-amz-server-side-encryption"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 300
  }
]
```

The API CORS allowlist must contain the same frontend origins. `https://www.vikrant.info` is not included unless separately approved.
