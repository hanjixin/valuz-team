-- IM channels: a bot in Feishu that people talk to; each chat maps to one session.
CREATE TABLE channels (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  owner_id    uuid NOT NULL REFERENCES users(id),
  -- Sessions started from the channel run in this project (its device and folder).
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('feishu')),
  name        text NOT NULL,
  agent_slug  text NOT NULL,
  app_id      text NOT NULL,
  -- Encrypted JSON: app_secret, verification_token, encrypt_key.
  secret_enc  text NOT NULL,
  -- Open-platform base URL: empty = feishu.cn; set for Lark or a private deployment.
  api_base    text NOT NULL DEFAULT '',
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channels_org ON channels (org_id);

CREATE TABLE channel_threads (
  channel_id       uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_chat_id text NOT NULL,
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, external_chat_id)
);
CREATE INDEX channel_threads_session ON channel_threads (session_id);
