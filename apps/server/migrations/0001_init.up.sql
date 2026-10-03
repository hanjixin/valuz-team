-- Identity & organizations
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orgs (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id    uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user ON org_members (user_id);

CREATE TABLE org_invites (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

-- One share ladder for every shareable resource.
CREATE TABLE resource_shares (
  id             uuid PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  resource_type  text NOT NULL,
  resource_id    uuid NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('org', 'team', 'user')),
  principal_id   uuid NOT NULL,
  permission     text NOT NULL CHECK (permission IN ('view', 'use', 'edit', 'control')),
  rank           smallint NOT NULL,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, principal_type, principal_id)
);
CREATE INDEX resource_shares_principal ON resource_shares (principal_type, principal_id);

-- Devices: desktop hosts (and headless runners) that execute sessions.
CREATE TABLE devices (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL REFERENCES users(id),
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  info         jsonb NOT NULL DEFAULT '{}',
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_org ON devices (org_id);

-- Shared resource library
CREATE TABLE providers (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  provider_kind text NOT NULL DEFAULT 'custom',
  protocol      text NOT NULL CHECK (protocol IN ('anthropic', 'openai_completion', 'openai_response', 'gemini')),
  base_url      text,
  default_model text,
  model_ids     jsonb NOT NULL DEFAULT '[]',
  secret_enc    text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX providers_org ON providers (org_id);

CREATE TABLE skills (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users(id),
  slug        text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  files       jsonb NOT NULL DEFAULT '[]',
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE connectors (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users(id),
  slug        text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  config      jsonb NOT NULL,
  secret_enc  text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE agents (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id        uuid NOT NULL REFERENCES users(id),
  slug            text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  avatar          text,
  instructions    text NOT NULL DEFAULT '',
  runtime         text NOT NULL DEFAULT 'claude_agent',
  model           text NOT NULL DEFAULT '',
  provider_id     uuid REFERENCES providers(id) ON DELETE SET NULL,
  effort          text,
  permission_mode text NOT NULL DEFAULT 'full_access',
  skills          jsonb NOT NULL DEFAULT '[]',
  connectors      jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE projects (
  id                      uuid PRIMARY KEY,
  org_id                  uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id                uuid NOT NULL REFERENCES users(id),
  name                    text NOT NULL,
  kind                    text NOT NULL DEFAULT 'project',
  icon                    text,
  instructions_md         text NOT NULL DEFAULT '',
  default_lead_agent_slug text,
  device_id               uuid REFERENCES devices(id) ON DELETE SET NULL,
  root_path               text,
  memory_summary          text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_org ON projects (org_id);

-- Deployment is a live reference to the library agent, not a copy.
CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, agent_id)
);

-- Kernel system of record
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY,
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id           uuid NOT NULL REFERENCES users(id),
  device_id          uuid REFERENCES devices(id) ON DELETE SET NULL,
  project_id         uuid REFERENCES projects(id) ON DELETE SET NULL,
  agent_id           uuid REFERENCES agents(id) ON DELETE SET NULL,
  provider_id        uuid REFERENCES providers(id) ON DELETE SET NULL,
  title              text NOT NULL DEFAULT '',
  runtime_provider   text NOT NULL,
  model              text NOT NULL DEFAULT '',
  cwd                text NOT NULL,
  agent_config       jsonb NOT NULL,
  model_settings     jsonb,
  instructions       text NOT NULL DEFAULT '',
  permission_mode    text NOT NULL DEFAULT 'full_access',
  mode               text NOT NULL DEFAULT 'default',
  status             text NOT NULL DEFAULT 'created',
  stop_reason        jsonb,
  metadata           jsonb NOT NULL DEFAULT '{}',
  runtime_session_id text,
  todos              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_org_updated ON sessions (org_id, updated_at DESC);
CREATE INDEX sessions_device ON sessions (device_id);
CREATE INDEX sessions_project ON sessions (project_id);

CREATE TABLE messages (
  id                 uuid PRIMARY KEY,
  session_id         uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  actor_id           uuid REFERENCES users(id),
  user_message       jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'running',
  assistant_message  text,
  error_message      jsonb,
  stop_reason        jsonb,
  total_turns        integer NOT NULL DEFAULT 0,
  input_tokens       bigint,
  output_tokens      bigint,
  cache_read_tokens  bigint,
  cache_write_tokens bigint,
  model_usage        jsonb,
  metadata           jsonb NOT NULL DEFAULT '{}',
  todos              jsonb,
  started_at         bigint NOT NULL,
  ended_at           bigint
);
CREATE INDEX messages_session ON messages (session_id, started_at);

CREATE TABLE events (
  seq        bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  ts         bigint NOT NULL,
  event_uid  uuid NOT NULL UNIQUE
);
CREATE INDEX events_session_seq ON events (session_id, seq);

-- Cloud storage
CREATE TABLE storage_configs (
  org_id           uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  driver           text NOT NULL CHECK (driver IN ('local', 's3')),
  endpoint         text,
  region           text,
  bucket           text,
  prefix           text NOT NULL DEFAULT '',
  access_key_id    text,
  secret_enc       text,
  force_path_style boolean NOT NULL DEFAULT false,
  updated_by       uuid NOT NULL REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL REFERENCES users(id),
  project_id   uuid REFERENCES projects(id) ON DELETE SET NULL,
  name         text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size         bigint NOT NULL DEFAULT 0,
  driver       text NOT NULL,
  storage_key  text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_org ON files (org_id, created_at DESC);

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id      uuid REFERENCES users(id),
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  detail        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org ON audit_logs (org_id, id DESC);
