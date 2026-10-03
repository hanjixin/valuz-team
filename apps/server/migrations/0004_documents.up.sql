-- Knowledge base: documents parsed to text chunks that agents search while they work.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE documents (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users(id),
  -- NULL = the organization's shared library; otherwise one project's knowledge base.
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  title       text NOT NULL,
  filename    text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'parsing', 'ready', 'failed')),
  error       text,
  -- The full extracted text; chunks are only the search index over it.
  content     text NOT NULL DEFAULT '',
  text_chars  integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_scope ON documents (org_id, project_id);

CREATE TABLE document_chunks (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord         integer NOT NULL,
  content     text NOT NULL
);
CREATE INDEX document_chunks_doc ON document_chunks (document_id, ord);
-- Trigram index: substring search that works for CJK as well as space-separated languages.
CREATE INDEX document_chunks_trgm ON document_chunks USING gin (content gin_trgm_ops);
