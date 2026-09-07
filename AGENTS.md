# StoryScout Backend Guidance

## Approval boundary

- Present a concrete, technology-specific plan and wait for explicit approval
  before executing project work.
- Implement only the approved scope.
- Do not add a feature, persona, domain entity, field, integration, or workflow
  unless the user explicitly requested and approved it.
- Do not commit, push, deploy, make external API calls, or perform other external
  writes without explicit approval.

## Product boundary

- Use Node.js and TypeScript for backend implementation.
- The versioned REST API is the public product boundary for all frontends.
- The only approved product features are Record and Transcribe.
- Keep audio and transcription persistence behind storage interfaces.
- Use local-computer storage first. Do not implement S3 or AWS yet.
- Storytellers/personas, translation, summaries, AI metadata, authentication,
  and database behavior are out of scope.
- When separately approved, keep the canonical OpenAPI specification, Postman
  collection, Postman local environment, and curl documentation in this repo.

## Continuity

- Update `STATUS.md` after every meaningful completed step.
- Update the active plan's `progress-log.md` after every meaningful completed
  step.
- On resumption, read the approved plan, progress log, and `STATUS.md`; inspect
  the actual files and rerun the last relevant validation before continuing.
