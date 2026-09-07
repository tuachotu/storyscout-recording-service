# StoryScout Recording Service

Node.js and TypeScript REST service for StoryScout's participant-gated recording ingestion flow.
It issues short-lived participant sessions, creates participant-scoped recording records, returns
presigned Amazon S3 upload instructions, and verifies uploads before marking them ready.

## Current scope

The running application exposes the recording-ingestion portion of the StoryScout API:

- health and S3 readiness checks;
- temporary bearer sessions issued from configured participant GUIDs;
- direct, private S3 audio uploads through short-lived presigned URLs;
- S3-backed recording metadata and upload-completion verification; and
- participant ownership checks for recording access.

The repository also contains earlier local transcription components, but they are not registered by
the current application entry point. The versioned OpenAPI document is the canonical description of
the active HTTP contract.

## Requirements

- Node.js 22.13 or newer, or Node.js 24+
- npm
- An AWS account, private S3 bucket, and AWS credentials with access to the configured recording
  prefix

## Local setup

```sh
npm ci
cp .env.example .env
npm run dev
```

Replace every placeholder in `.env` before starting the service. The default server address is
`http://localhost:3001`; all API routes are under `/api/v1`.

Do not commit `.env`, participant GUIDs, signing secrets, AWS credentials, recordings, or other
runtime data. These files and the local data directory are excluded by `.gitignore`.

## Configuration

| Variable                   | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `HOST`                     | Server bind address.                                            |
| `PORT`                     | Server port.                                                    |
| `WEBAPP_ORIGIN`            | Single allowed browser origin when `WEBAPP_ORIGINS` is not set. |
| `WEBAPP_ORIGINS`           | Comma-separated browser-origin allowlist.                       |
| `MAX_AUDIO_BYTES`          | Maximum accepted recording size.                                |
| `AWS_REGION`               | AWS region containing the recording bucket.                     |
| `S3_RECORDING_BUCKET`      | Private S3 bucket used for audio and recording metadata.        |
| `RECORDING_PREFIX`         | Root S3 key prefix, normally `recordings`.                      |
| `PARTICIPANTS_JSON`        | JSON array of allowed participant GUIDs and display names.      |
| `SESSION_SIGNING_SECRET`   | Secret of at least 32 characters used to sign access sessions.  |
| `SESSION_LIFETIME_SECONDS` | Lifetime of an issued access session.                           |
| `UPLOAD_URL_SECONDS`       | Lifetime of a presigned recording-upload URL (60–3600 seconds). |

Production startup rejects the built-in development signing secret and an empty participant list.
Supply credentials to the AWS SDK through its standard credential provider chain; do not add access
keys to this repository.

## API overview

| Method | Route                                       | Purpose                                                         |
| ------ | ------------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/api/v1/health`                            | Process health check.                                           |
| `GET`  | `/api/v1/ready`                             | S3 readiness check.                                             |
| `POST` | `/api/v1/access-sessions`                   | Exchange a participant GUID for a temporary bearer token.       |
| `POST` | `/api/v1/recordings`                        | Create a recording and obtain presigned S3 upload instructions. |
| `GET`  | `/api/v1/recordings/{recordingId}`          | Read participant-owned recording status.                        |
| `POST` | `/api/v1/recordings/{recordingId}/complete` | Verify the S3 object and complete ingestion.                    |

See [`openapi/storyscout-v1.yaml`](openapi/storyscout-v1.yaml) for the full contract and
[`docs/curl-examples.md`](docs/curl-examples.md) for request examples. A generated Postman
collection and local environment are available under [`postman/`](postman/).

## Development commands

```sh
npm run dev             # start the TypeScript development server in watch mode
npm run typecheck       # type-check without emitting output
npm run lint            # lint source and tests
npm run format:check    # verify formatting
npm test                # run the active recording-service test suite
npm run contract:check  # validate OpenAPI and committed Postman JSON
npm run build           # compile production JavaScript into dist/
npm run check           # run the complete validation gate
```

Generated dependencies, build output, coverage, local recordings, and environment files are not
committed.

## Container image

The included multi-stage `Dockerfile` builds the TypeScript service and runs it as the unprivileged
Node user on port 3001.

```sh
docker build -t storyscout-recording-service .
docker run --rm --env-file .env -p 3001:3001 storyscout-recording-service
```

The container does not provision AWS resources. Deployment and minimum S3 permissions are described
in [`docs/aws-recording-ingestion.md`](docs/aws-recording-ingestion.md).

## Security notes

- Keep the S3 bucket private with Block Public Access enabled.
- Grant the runtime role only the required operations under the configured recording prefix.
- Restrict API and bucket CORS to reviewed frontend origins.
- Store `PARTICIPANTS_JSON` and `SESSION_SIGNING_SECRET` in the runtime's secret/configuration
  service, not in an image or Git.
- Presigned upload URLs are bearer credentials until they expire; avoid logging or sharing them.

## License

No open-source license has been granted for this repository. All rights are reserved.
