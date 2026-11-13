// Sample messages for the fake Server: the messages the accepted design draws.
// Every message is a legal Harklight message (attention-client.actions/1).

const seenDescriptor = {
  schema: 'attention-client.actions/1',
  actions: [{ id: 'seen', label: 'Seen', kind: 'value', value: { acknowledgment: 'seen' } }],
};

function at(now, daysAgo, hour, minute) {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

export function fixture(now) {
  return [
    {
      message: {
        sender_id: 'agent:finance',
        message_id: 'card-expiry',
        display_name: 'Finance agent',
        created_at: at(now, 4, 10, 5),
        title: 'The hosting card expires next month',
        body: 'Renewals after December 1 will fail unless the card is replaced.',
        message_type: 'fyi',
        message_kind: 'blocker',
        answer_ui: seenDescriptor,
      },
      chat: false,
    },
    {
      message: {
        sender_id: 'agent:research',
        message_id: 'survey',
        display_name: 'Research agent',
        created_at: at(now, 4, 9, 30),
        title: 'Approve the survey questions?',
        body: 'Fourteen questions, about six minutes to complete.',
        message_type: 'request',
        answer_ui: {
          schema: 'attention-client.actions/1',
          actions: [
            { id: 'approve', label: 'Approve', kind: 'value', value: 'approve' },
            { id: 'revise', label: 'Ask for changes', kind: 'value', value: { decision: 'revise' } },
          ],
        },
      },
    },
    {
      message: {
        sender_id: 'agent:build',
        message_id: 'quarterly',
        display_name: 'Build agent',
        created_at: at(now, 1, 16, 20),
        title: 'Quarterly report is ready',
        body: 'All twelve sections are written and the figures match the ledger.',
        message_type: 'fyi',
        message_kind: 'success',
        answer_ui: seenDescriptor,
      },
      chat: false,
    },
    {
      message: {
        sender_id: 'agent:calendar',
        message_id: 'week',
        display_name: 'Calendar agent',
        created_at: at(now, 0, 8, 2),
        title: 'Your week ahead',
        body: 'Nine meetings, two of them moved. Thursday afternoon is free.',
        message_type: 'fyi',
        answer_ui: seenDescriptor,
      },
      chat: false,
      answered: { kind: 'seen' },
    },
    {
      message: {
        sender_id: 'agent:research',
        message_id: 'lisbon',
        display_name: 'Research agent',
        created_at: at(now, 0, 9, 12),
        title: 'Which hotel should I book for Lisbon?',
        body: 'Two rooms are still free for the conference dates. Both can be cancelled until Friday.',
        message_type: 'request',
        default: { value: 'avenida', at: at(now, 0, 18, 0) },
        answer_ui: {
          schema: 'attention-client.actions/1',
          actions: [
            { id: 'avenida', label: 'Hotel Avenida', kind: 'value', value: 'avenida' },
            { id: 'plaza', label: 'Lisboa Plaza', kind: 'value', value: 'plaza' },
            { id: 'reply', label: 'Reply', kind: 'text' },
          ],
        },
      },
      chatTurns: [
        { author: 'origin', text: 'I can hold either room until 6 PM today.' },
        { author: 'person', text: 'Does the Avenida have a desk in the room?', delivered: true },
        { author: 'origin', text: 'Yes. Every room has a desk and wired internet.' },
      ],
    },
    {
      message: {
        sender_id: 'agent:deploy',
        message_id: 'deploy-failed',
        display_name: 'Deploy agent',
        created_at: at(now, 0, 9, 41),
        title: 'Production deploy failed',
        body: 'The 9:30 release stopped at the database step. Nothing was changed. I need a decision before I retry.',
        message_type: 'request',
        message_kind: 'blocker',
        urgency: 'now',
        answer_ui: {
          schema: 'attention-client.actions/1',
          actions: [
            { id: 'retry', label: 'Retry the release', kind: 'value', value: 'retry' },
            { id: 'hold', label: 'Hold until tomorrow', kind: 'value', value: 'hold' },
            { id: 'reply', label: 'Reply', kind: 'text' },
          ],
        },
      },
    },
  ];
}
