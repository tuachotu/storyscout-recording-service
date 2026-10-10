# StoryScout API curl examples

These examples exercise the approved Record and Transcribe REST contract. The Record commands and
recording-transcription retrieval are executable against the backend. The older transcription-job
commands remain contract examples until that separately approved phase is integrated into the
running application.

## Configure the local URL and sample file

```bash
export STORYSCOUT_API_URL="http://localhost:3001/api/v1"
export AUDIO_FILE="/absolute/path/to/audio.mp3"
export AUDIO_CONTENT_TYPE="audio/mpeg"
```

Use an M4A, MP3, WAV, or supported browser-recorded audio file. Do not put API
keys in these variables. Set `AUDIO_CONTENT_TYPE` to the file's MIME type, such
as `audio/mp4`, `audio/mpeg`, `audio/wav`, or `audio/webm`.

## Check API health

```bash
curl \
  --request GET \
  --header "Accept: application/json" \
  "${STORYSCOUT_API_URL}/health"
```

Expected response:

```json
{ "status": "ok" }
```

## Create a recording

```bash
curl \
  --request POST \
  --header "Accept: application/json" \
  "${STORYSCOUT_API_URL}/recordings"
```

Copy the returned opaque ID:

```bash
export RECORDING_ID="recording_..."
```

## Upload audio to the recording

```bash
curl \
  --request POST \
  --header "Accept: application/json" \
  --form "audio=@${AUDIO_FILE};type=${AUDIO_CONTENT_TYPE}" \
  "${STORYSCOUT_API_URL}/recordings/${RECORDING_ID}/audio"
```

## Get recording information

```bash
curl \
  --request GET \
  --header "Accept: application/json" \
  "${STORYSCOUT_API_URL}/recordings/${RECORDING_ID}"
```

## Get the recording transcription

The transcription worker stores `transcription.txt` beside the recording objects in S3. Retrieval
requires the same participant bearer session used for recording access.

```bash
curl \
  --request GET \
  --header "Accept: application/json" \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${STORYSCOUT_API_URL}/recordings/${RECORDING_ID}/transcription"
```

The response contains the recording metadata and `transcription.text`. A ready recording without a
`transcription.txt` object returns `404 TRANSCRIPTION_NOT_FOUND`; an incomplete recording returns
`409 RECORDING_NOT_READY`.

## Stream the complete audio file

```bash
curl \
  --request GET \
  --output recording-audio \
  "${STORYSCOUT_API_URL}/recordings/${RECORDING_ID}/audio"
```

## Request an audio byte range

```bash
curl \
  --request GET \
  --header "Range: bytes=0-1048575" \
  --output recording-audio-part \
  "${STORYSCOUT_API_URL}/recordings/${RECORDING_ID}/audio"
```

## Start transcription for an existing recording

```bash
curl \
  --request POST \
  --header "Accept: application/json" \
  --header "Content-Type: application/json" \
  --data "{\"recordingId\":\"${RECORDING_ID}\"}" \
  "${STORYSCOUT_API_URL}/transcriptions"
```

Copy the returned opaque ID:

```bash
export TRANSCRIPTION_ID="transcription_..."
```

## Start transcription directly from a local file

This creates its own technical recording and then starts transcription.

```bash
curl \
  --request POST \
  --header "Accept: application/json" \
  --form "file=@${AUDIO_FILE};type=${AUDIO_CONTENT_TYPE}" \
  "${STORYSCOUT_API_URL}/transcriptions"
```

## Check transcription status

```bash
curl \
  --request GET \
  --header "Accept: application/json" \
  "${STORYSCOUT_API_URL}/transcriptions/${TRANSCRIPTION_ID}"
```

The `state` value is one of `queued`, `processing`, `completed`, or `failed`.

## Get the transcript as JSON

```bash
curl \
  --request GET \
  --header "Accept: application/json" \
  "${STORYSCOUT_API_URL}/transcriptions/${TRANSCRIPTION_ID}/transcript?format=json"
```

## Download the transcript as text

```bash
curl \
  --request GET \
  --header "Accept: text/plain" \
  --output transcript.txt \
  "${STORYSCOUT_API_URL}/transcriptions/${TRANSCRIPTION_ID}/transcript?format=text"
```

## Retry a failed transcription

```bash
curl \
  --request POST \
  --header "Accept: application/json" \
  "${STORYSCOUT_API_URL}/transcriptions/${TRANSCRIPTION_ID}/retry"
```

## Error response

Errors use one shape:

```json
{
  "error": {
    "code": "UNSUPPORTED_AUDIO_FORMAT",
    "message": "The selected audio format is not supported.",
    "requestId": "request_..."
  }
}
```

Common contract errors include:

- `400 INVALID_REQUEST`
- `404 RECORDING_NOT_FOUND`
- `404 TRANSCRIPTION_NOT_FOUND`
- `409 RECORDING_AUDIO_EXISTS`
- `409 TRANSCRIPTION_NOT_COMPLETE`
- `413` for an audio file over the configured limit
- `415 UNSUPPORTED_AUDIO_FORMAT`
- `416` for an invalid audio byte range
