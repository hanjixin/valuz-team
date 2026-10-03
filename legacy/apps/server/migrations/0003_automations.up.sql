-- Scheduled automations: an agent instruction that runs on a cron schedule inside a project.
CREATE TABLE automations (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users(id),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  agent_slug  text NOT NULL,
  prompt      text NOT NULL,
  cron        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'UTC',
  enabled     boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automations_project ON automations (project_id);

CREATE TABLE automation_runs (
  id            uuid PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  session_id    uuid REFERENCES sessions(id) ON DELETE SET NULL,
  trigger       text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status        text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  error         text,
  summary       text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz
);
CREATE INDEX automation_runs_automation ON automation_runs (automation_id, started_at DESC);
CREATE INDEX automation_runs_session ON automation_runs (session_id);
