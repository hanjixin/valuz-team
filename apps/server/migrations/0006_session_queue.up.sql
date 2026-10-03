-- Messages typed while a turn is running wait here and are sent, in order, as turns finish.
CREATE TABLE queued_inputs (
  id         uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  actor_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queued_inputs_session ON queued_inputs (session_id, created_at);

-- A person's verdict on one turn.
CREATE TABLE message_feedback (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     text NOT NULL CHECK (rating IN ('up', 'down')),
  comment    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
