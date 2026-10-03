-- Goal-driven multi-agent tasks: a durable header that owns a plan DAG, the
-- runs (kernel sessions) it spawned, an append-only timeline, and a mailbox.
CREATE TABLE tasks (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users(id),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_id       uuid REFERENCES devices(id) ON DELETE SET NULL,
  title           text NOT NULL,
  goal            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'stopped', 'completed', 'blocked', 'abandoned')),
  lead_agent_slug text NOT NULL,
  lead_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  cwd             text NOT NULL,
  plan            jsonb NOT NULL DEFAULT '{"subtasks": []}',
  plan_version    integer NOT NULL DEFAULT 0,
  result          jsonb,
  -- Consecutive lead turns that ended with work outstanding and nothing in flight.
  idle_nudges     integer NOT NULL DEFAULT 0,
  committed_at    timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_project ON tasks (project_id, created_at DESC);
CREATE INDEX tasks_org ON tasks (org_id, updated_at DESC);

-- A run is one kernel session working for the task: the lead, or one dispatch of a subtask.
CREATE TABLE task_runs (
  id          uuid PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  agent_slug  text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('lead', 'subtask')),
  subtask_key text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'rejected', 'archived')),
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX task_runs_task ON task_runs (task_id, created_at);

CREATE TABLE task_events (
  seq        bigserial PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type       text NOT NULL,
  actor      text NOT NULL,
  session_id uuid,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task ON task_events (task_id, seq);

-- Messages waiting for an actor (lead or member). Consumed exactly once.
CREATE TABLE task_mailbox (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL,
  kind        text NOT NULL,
  text        text NOT NULL DEFAULT '',
  payload     jsonb NOT NULL DEFAULT '{}',
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_mailbox_pending ON task_mailbox (session_id, id) WHERE consumed_at IS NULL;
