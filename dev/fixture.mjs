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

const COVER_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACgAAAAYCAIAAAAH5iiXAAAAL0lEQVR4nGOI6jmBBz07UYEHUaKXYdTiUYtHLR61eNTiUYtHLR61eNTiUYuHj8UAUF0t6nxPFLMAAAAASUVORK5CYII=';

/** Custom answer forms (attention-client.ui/1), drawn only with the answerForms flag. */
export function formFixture(now) {
  return [
    {
      message: {
        sender_id: 'agent:facilities',
        message_id: 'repair',
        display_name: 'Facilities agent',
        created_at: at(now, 0, 7, 30),
        title: 'Where should the repair crew start?',
        body: 'Mark the spot on the floor plan and add a note for the crew.',
        message_type: 'request',
        answer_ui: {
          schema: 'attention-client.ui/1',
          requires: ['scene/1', 'result/1', 'illustration/1', 'point/1', 'text/1'],
          illustrations: [
            {
              id: 'floor-plan',
              label: 'Floor plan with a door at the lower left, partition and desk at upper right',
              width: 300,
              height: 180,
              primitives: [
                { kind: 'rect', x: 0, y: 0, width: 300, height: 180, fill: '#EDF0E9' },
                { kind: 'line', x1: 10, y1: 10, x2: 290, y2: 10, stroke: '#38535E', strokeWidth: 4 },
                { kind: 'line', x1: 290, y1: 10, x2: 290, y2: 170, stroke: '#38535E', strokeWidth: 4 },
                { kind: 'line', x1: 290, y1: 170, x2: 90, y2: 170, stroke: '#38535E', strokeWidth: 4 },
                { kind: 'line', x1: 10, y1: 170, x2: 10, y2: 10, stroke: '#38535E', strokeWidth: 4 },
                { kind: 'line', x1: 150, y1: 10, x2: 150, y2: 100, stroke: '#38535E', strokeWidth: 4 },
                { kind: 'rect', x: 190, y: 30, width: 70, height: 40, fill: '#7795A3' },
                { kind: 'text', x: 30, y: 155, text: 'Door', fill: '#38535E', fontSize: 16, align: 'start' },
              ],
            },
          ],
          inputs: [
            { kind: 'point', id: 'location', label: 'Repair location', illustration: 'floor-plan' },
            { kind: 'text', id: 'note', label: 'Note' },
          ],
          open: {
            kind: 'stack',
            axis: 'vertical',
            children: [
              { kind: 'text', text: 'Mark the repair location', style: 'title' },
              { kind: 'input', id: 'location', layout: 'diagram' },
              { kind: 'input', id: 'note', layout: 'editor' },
            ],
          },
          resolved: { kind: 'text', text: 'Location request closed', style: 'title' },
          submission: {
            label: 'Send',
            result: {
              kind: 'object',
              members: [
                { name: 'point', value: { kind: 'input', id: 'location' } },
                { name: 'note', value: { kind: 'input', id: 'note' } },
                { name: 'drawingRevision', value: { kind: 'literal', value: 7 } },
              ],
            },
          },
        },
      },
    },
    {
      message: {
        sender_id: 'agent:design',
        message_id: 'cover',
        display_name: 'Design agent',
        created_at: at(now, 0, 7, 10),
        title: 'Which cover for the November issue?',
        body: 'Both drafts use the same headline.',
        message_type: 'request',
        answer_ui: {
          schema: 'attention-client.ui/1',
          requires: ['scene/1', 'result/1', 'illustration/1', 'image/1', 'response/1'],
          illustrations: [
            {
              id: 'cover-a',
              label: 'Cover A, blue stripes',
              width: 400,
              height: 240,
              primitives: [
                { kind: 'rect', x: 0, y: 0, width: 400, height: 240, fill: '#DDE4EE' },
                { kind: 'image', x: 0, y: 0, width: 400, height: 240, file: 'cover-a.png' },
                { kind: 'text', x: 200, y: 230, text: 'Cover A', fill: '#101725', fontSize: 22, align: 'middle' },
              ],
            },
            {
              id: 'cover-b',
              label: 'Cover B, plain amber',
              width: 400,
              height: 240,
              primitives: [
                { kind: 'rect', x: 0, y: 0, width: 400, height: 240, fill: '#F2D9A6' },
                { kind: 'circle', cx: 200, cy: 110, r: 60, fill: '#C9822B' },
                { kind: 'text', x: 200, y: 230, text: 'Cover B', fill: '#101725', fontSize: 22, align: 'middle' },
              ],
            },
          ],
          inputs: [
            {
              kind: 'response',
              id: 'cover',
              label: 'Choose a cover',
              actions: [
                { id: 'a', label: 'Use cover A', kind: 'value', value: { cover: 'A' }, illustration: 'cover-a' },
                { id: 'b', label: 'Use cover B', kind: 'value', value: { cover: 'B' }, illustration: 'cover-b' },
                { id: 'other', label: 'Something else', kind: 'text' },
              ],
            },
          ],
          open: { kind: 'input', id: 'cover', layout: 'cards' },
          resolved: { kind: 'text', text: 'Cover chosen', style: 'body' },
          submission: { label: 'Send', result: { kind: 'input', id: 'cover' } },
        },
      },
      files: [{ name: 'cover-a.png', tier: 'inline', size: 104, sha256: 'bd5b8be61a1301a927de593c92723a13647345f96d55ce493b2141d4ce80ee38', data_base64: COVER_PNG }],
    },
  ];
}
