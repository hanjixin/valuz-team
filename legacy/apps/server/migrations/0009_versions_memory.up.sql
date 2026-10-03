-- Every content change of a skill is kept, so it can be inspected and restored.
CREATE TABLE skill_versions (
  skill_id    uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  files       jsonb NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);
INSERT INTO skill_versions (skill_id, version, name, description, files, created_by, created_at)
  SELECT id, version, name, description, files, owner_id, updated_at FROM skills;

-- What a project's team has learned: facts worth carrying into every future session.
CREATE TABLE project_memories (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content    text NOT NULL,
  source     text NOT NULL CHECK (source IN ('user', 'agent')),
  author_id  uuid REFERENCES users(id),
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_memories_project ON project_memories (project_id, created_at);
