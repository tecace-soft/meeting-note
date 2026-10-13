---
title: "MCP 툴 레퍼런스"
slug: mcp-tools-reference
section: "Integrations"
order: 2
revision: "2026-10-13.1"
source_of_truth: "generated from workflow-server MCP server (npm run docs:generate)"
generated: true
---

# MCP 툴 레퍼런스

<!-- 아래 수기 노트는 재생성(docs:generate) 시 보존됩니다. 마커 안쪽만 자동 갱신됩니다. -->
> 각 툴의 출력(응답) 형태, 소유권, 접근 권한 범위는 이 문서가 아니라 서버 핸들러 코드에서 결정됩니다.
> 이 문서는 코드에서 자동 추출 가능한 이름·설명·입력 파라미터만 다룹니다.

<!-- GENERATED:mcp-tools START -->
> 이 영역은 `npm run docs:generate`로 MCP 서버의 등록된 툴에서 자동 생성됩니다. 손으로 편집하지 마세요.

Meeting Note MCP 서버에 등록된 툴은 총 30개입니다. 아래 표는 각 툴의 이름, 설명, 입력 파라미터만 다룹니다.
대부분의 툴은 공통 평가 필드(`user_intent`·`reason_for_tool_choice`는 필수, `expected_answer_type`는 선택)도 받지만, 모든 툴에 동일하게 적용되므로 아래에서는 생략했습니다.
출력(응답) 형태·소유권·권한 범위는 서버 핸들러에서 결정되므로 이 자동 생성 영역에서는 다루지 않습니다.

### `add_note_to_project`

**Add Note to Project**

Organize a meeting: add an accessible note to one of YOUR projects. The note must be owned by or shared with you and the project must be yours. Idempotent (adding a note already in the project is a no-op). After this, project-scoped queries (search_notes / find_action_items / find_events with projectId) include the note.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `noteId` | string | 필수 |  |
| `projectId` | string | 필수 |  |

### `fetch`

**Fetch Meeting Note**

Fetch the full summary and transcript of one meeting note by the id returned from search.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 필수 |  |

### `find_action_items`

**Find Action Items**

Find action items and follow-ups from accessible meetings, with source note evidence. Uses the structured note_insight index (owner/due/status) when available, falling back to a summary-text heuristic for notes not yet indexed.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `projectId` | string | 선택 |  |
| `limit` | integer | 선택 |  |
| `noteLimit` | integer | 선택 |  |
| `maxItemsPerNote` | integer | 선택 |  |
| `includeTranscriptFallback` | boolean | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `find_events`

**Find Events (cause → effect)**

Find cause→effect events (what happened / was done and what it led to) across accessible meetings, with source note evidence. Best for reverse "what did I do / what happened and why" questions. Reads the structured note_insight.events index; notes not yet indexed have no events.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `projectId` | string | 선택 |  |
| `limit` | integer | 선택 |  |
| `noteLimit` | integer | 선택 |  |
| `maxItemsPerNote` | integer | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `get_attachment_context`

**Get Attachment Context**

Return attachment metadata for a meeting note. This does not download file contents.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `noteId` | string | 필수 |  |

### `get_meeting_brief`

**Get Meeting Brief**

Return one compact meeting package with metadata, summary, optional transcript excerpt, speakers, and attachment metadata.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `noteId` | string | 필수 |  |
| `includeTranscriptExcerpt` | boolean | 선택 |  |
| `includeAttachments` | boolean | 선택 |  |
| `maxSummaryCharacters` | integer | 선택 |  |
| `maxTranscriptCharacters` | integer | 선택 |  |

### `get_note`

**Get Note**

Get one note metadata record and availability flags without returning full transcript text.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `noteId` | string | 필수 |  |

### `get_note_speaker_segments`

**Get Note Speaker Segments**

Return diarized transcript segments for one or more speakers in a single note.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `noteId` | string | 필수 |  |
| `speakers` | string[] | 필수 |  |
| `maxSegments` | integer | 선택 |  |

### `get_note_summary`

**Get Note Summary**

Return the edited summary when present, otherwise the generated summary.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `noteId` | string | 필수 |  |
| `maxCharacters` | integer | 선택 |  |

### `get_note_transcript`

**Get Note Transcript**

Return plain transcript text or structured diarized transcript segments for a note.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `noteId` | string | 필수 |  |
| `format` | enum | 선택 |  |
| `maxCharacters` | integer | 선택 |  |
| `maxSegments` | integer | 선택 |  |

### `get_notes_by_date`

**Get Notes By Date**

Retrieve note metadata for notes created on a single date or within a date range.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `limit` | integer | 선택 |  |
| `projectId` | string | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `get_product_docs`

**Get Product Docs**

Read Meeting Note product documentation written for AI agents and people: product overview, the AI-agent guide, the F2 feedback/issues spec, the MCP connection guide, and release history. Call with no slug to list the available docs; call with a slug to fetch that doc as markdown. TecAce-internal; requires an org-verified connection.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `slug` | string | 선택 |  |

### `get_project_context`

**Get Project Context**

Get a project with recent notes, summaries, speakers, and transcript availability.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `projectId` | string | 필수 |  |
| `noteLimit` | integer | 선택 |  |

### `get_project_timeline`

**Get Project Timeline**

Return project-related meetings in chronological order with compact summaries.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `projectId` | string | 필수 |  |
| `limit` | integer | 선택 |  |
| `maxCharactersPerSummary` | integer | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `get_shared_notes_by_owner`

**Get Shared Notes By Owner**

Find notes shared with the current user where the owner name matches a passed name, such as "Gene" matching "Gene Kim (김진)".

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ownerName` | string | 필수 |  |
| `limit` | integer | 선택 |  |
| `projectId` | string | 선택 |  |
| `maxCharactersPerSummary` | integer | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `get_speaker_profile`

**Get Speaker Profile**

Fetch a saved speaker profile/ontology by speaker id or exact speaker name.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `speakerId` | string | 선택 |  |
| `speakerName` | string | 선택 |  |
| `maxCharacters` | integer | 선택 |  |

### `get_speaker_segments`

**Get Speaker Segments**

Find diarized transcript segments by speaker name. Use this for questions like "points made by Gene"; pass noteId for one meeting, or omit noteId to search accessible personal and shared notes.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `speakerName` | string | 필수 |  |
| `noteId` | string | 선택 |  |
| `noteScope` | enum | 선택 |  |
| `projectId` | string | 선택 |  |
| `noteLimit` | integer | 선택 |  |
| `maxSegments` | integer | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `get_summaries_by_date`

**Get Summaries By Date**

Retrieve note summaries for notes created on a single date or within a date range.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `limit` | integer | 선택 |  |
| `projectId` | string | 선택 |  |
| `maxCharactersPerSummary` | integer | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `get_transcripts_by_date`

**Get Transcripts By Date**

Retrieve note transcripts for notes created on a single date or within a date range.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `limit` | integer | 선택 |  |
| `projectId` | string | 선택 |  |
| `format` | enum | 선택 |  |
| `maxCharactersPerTranscript` | integer | 선택 |  |
| `maxSegmentsPerTranscript` | integer | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `list_personal_notes`

**List Personal Notes**

List notes owned by the current user only, excluding notes shared by others.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `limit` | integer | 선택 |  |
| `projectId` | string | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `list_projects`

**List Projects**

List projects with basic metadata and note counts when available.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `limit` | integer | 선택 |  |

### `list_recent_notes`

**List Recent Notes**

List recent meeting notes with metadata, tags, and projects. Transcript/speaker availability is not checked in this list view (fields are null/unknown); use get_note or the transcript tools to confirm a specific note.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `limit` | integer | 선택 |  |
| `projectId` | string | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `list_shared_notes`

**List Shared Notes**

List notes shared with the current user by other note owners.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `limit` | integer | 선택 |  |
| `projectId` | string | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `list_speakers`

**List Speakers**

List saved speakers and whether each speaker has a saved profile.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `query` | string | 선택 |  |
| `limit` | integer | 선택 |  |

### `log_final_answer`

**Log Final Answer**

Optional evaluation tool. Call this after producing the final user-facing answer when the MCP client allows it, so Meeting Note can evaluate the final response quality.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `user_query` | string | 선택 | The original user query when available. |
| `final_answer` | string | 필수 | The final answer that will be shown to the user. |
| `answer_quality_notes` | string | 선택 | Optional notes about uncertainty, missing data, or tool limitations. |

### `recall_personal_context`

**Recall Personal Context**

Return the logged-in user's durable PERSONAL MEMORY: a synthesized, cross-meeting understanding of THEIR OWN work, accumulated across all of their meetings (ongoing projects, recurring collaborators, the user's own open commitments, and the reasons behind past decisions). Use this for PERSON-level questions about the caller THEMSELVES that span many meetings, e.g. 'what have I been working on lately?', 'what are my open commitments?', 'who do I work with most?', 'why did we decide X?'. This is the caller's OWN memory only: it CANNOT answer what a specific other person did (use find_action_items or search_notes for owner-attributed facts), nor per-meeting details (use get_meeting_brief / get_notes_by_date). Returns the current standing memory items, most-recently-updated first; each item is one self-contained fact with the entities it mentions.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `limit` | integer | 선택 |  |

### `remove_note_from_project`

**Remove Note from Project**

Un-organize a meeting: remove a note from one of YOUR projects. The project must be yours and the note owned by or shared with you. Idempotent (removing a note not in the project is a no-op). After this, project-scoped queries (search_notes / find_action_items / find_events with projectId) no longer include the note.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `noteId` | string | 필수 |  |
| `projectId` | string | 필수 |  |

### `search`

**Search Meeting Notes**

Search the meeting notes the signed-in user can access (own and shared) by title, summary, transcript, people, topics and companies. Returns note ids to pass to fetch.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `query` | string | 필수 |  |

### `search_notes`

**Search Notes**

Search accessible notes by title, summary, transcript, and structured index (people, topics, companies). Ranked, index-backed (covers all notes, not a capped scan). Returns matched people/topics/companies per hit.

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `query` | string | 필수 |  |
| `projectId` | string | 선택 |  |
| `limit` | integer | 선택 |  |
| `date` | string | 선택 |  |
| `startDate` | string | 선택 |  |
| `endDate` | string | 선택 |  |

### `search_personal_context`

**Search Personal Context**

Search the logged-in user's durable PERSONAL MEMORY for the items about a specific project, product, person, company, or topic. Use this (instead of recall_personal_context) when the question is SCOPED TO A NAMED ENTITY OR TOPIC, e.g. 'what do I know about the billing migration?', 'what's my history with Priya?', 'remind me about the AX project', 'what have we decided on pricing?'. recall_personal_context is for the BROAD "what have I been working on" with no specific subject; this one narrows to a query. It is a deterministic keyword/entity filter over the caller's OWN standing memory (matches the query against each item's entities and text), returning matching items most-relevant first. Caller's own memory only: it cannot answer what a specific OTHER person did (use find_action_items / search_notes) nor per-meeting details (use get_meeting_brief / get_notes_by_date).

| 파라미터 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- |
| `query` | string | 필수 | The project, product, person, company, or topic to find in the user's memory. |
| `limit` | integer | 선택 |  |
<!-- GENERATED:mcp-tools END -->
