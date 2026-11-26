// Wire shapes shared by center clients and server-side addressing routes.
// Keep this file type-only so both Bun and Node consumers can import it
// without pulling runtime code into a plugin bundle.

export type MessageRef = { id: string; seq: number };

export type CatchUpOptions = {
  sessionID: string;
  afterSeq?: number;
  limit?: number;
};

export type CatchUpPage = {
  messages: Array<Record<string, unknown>>;
  nextCursor: number;
  hasMore: boolean;
  unreadMentions: MessageRef[];
  unreadMentionCount: number;
  unansweredQuestions: MessageRef[];
  unansweredQuestionCount: number;
};