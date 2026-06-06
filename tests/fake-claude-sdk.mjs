export const taskMessages = [
  {
    type: "assistant",
    session_id: "task-session",
    message: {
      content: [{ type: "text", text: "Working on it." }]
    }
  },
  {
    type: "result",
    session_id: "task-session",
    result: "Task completed."
  }
];

export const reviewMessages = [
  {
    type: "assistant",
    sessionId: "review-session",
    message: {
      content: [{ type: "text", text: "Reviewing changes." }]
    }
  },
  {
    type: "result",
    sessionId: "review-session",
    result: "No issues found."
  }
];

export function createFakeClaudeSdk({ messages = taskMessages } = {}) {
  const calls = [];

  return {
    calls,
    query(params) {
      calls.push(params);
      return createAsyncMessageStream(messages);
    }
  };
}

async function* createAsyncMessageStream(messages) {
  for (const message of messages) {
    if (message instanceof Error) {
      throw message;
    }

    yield message;
  }
}
