// index.js
import express from 'express';
import fetch from 'node-fetch';

// =========================
// Jira Configuration
// =========================
const JIRA_BASE = 'https://10xbeta.atlassian.net';
const JIRA_USER = process.env.JIRA_USER_ID;
const JIRA_API_TOKEN = process.env.JIRA_ACCESS_TOKEN;
const JIRA_AUTH = Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64');

const app = express();
app.use(express.json());

// =========================
// Utility: Get Board ID for Project
// =========================
async function getBoardIdForProject(projectKey) {
  const url = `${JIRA_BASE}/rest/agile/1.0/board?projectKeyOrId=${projectKey}`;
  console.log('[getBoardIdForProject] Fetching:', url);
  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${JIRA_AUTH}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[getBoardIdForProject] Failed:', res.status, text);
    return null;
  }
  const data = await res.json();
  console.log('[getBoardIdForProject] Response:', data);
  if (data.values && data.values.length > 0) {
    return data.values[0].id; // Use the first board found
  }
  return null;
}

// =========================
// Utility: Get Current Sprint Dates for Board
// =========================
async function getCurrentSprintDates(boardId) {
  const sprintsUrl = `${JIRA_BASE}/rest/agile/1.0/board/${boardId}/sprint?state=active`;
  console.log('[getCurrentSprintDates] Fetching:', sprintsUrl);
  const sprintsRes = await fetch(sprintsUrl, {
    headers: {
      'Authorization': `Basic ${JIRA_AUTH}`,
      'Accept': 'application/json',
    },
  });
  if (!sprintsRes.ok) {
    const text = await sprintsRes.text();
    console.error('[getCurrentSprintDates] Jira API error (sprints):', sprintsRes.status, text);
    return {};
  }
  const sprintsBody = await sprintsRes.json();
  console.log('[getCurrentSprintDates] Sprints response:', sprintsBody);
  if (!sprintsBody.values || sprintsBody.values.length === 0) {
    console.log('[getCurrentSprintDates] No active sprints found.');
    return {};
  }
  const currentSprint = sprintsBody.values[0];

  const sprintDetailsUrl = `${JIRA_BASE}/rest/agile/1.0/sprint/${currentSprint.id}`;
  console.log('[getCurrentSprintDates] Fetching sprint details:', sprintDetailsUrl);
  const sprintDetailsRes = await fetch(sprintDetailsUrl, {
    headers: {
      'Authorization': `Basic ${JIRA_AUTH}`,
      'Accept': 'application/json',
    },
  });
  if (!sprintDetailsRes.ok) {
    const text = await sprintDetailsRes.text();
    console.error('[getCurrentSprintDates] Jira API error (sprint details):', sprintDetailsRes.status, text);
    return {};
  }
  const sprintDetails = await sprintDetailsRes.json();
  console.log('[getCurrentSprintDates] Sprint details response:', sprintDetails);
  const startDate = sprintDetails.startDate || sprintDetails.customfield_10015;
  const endDate = sprintDetails.endDate || sprintDetails.duedate;
  return { startDate, endDate };
}

// =========================
// Utility: Update Issue with Sprint Dates
// =========================
async function setTaskDatesToSprint(issueKey, startDate, endDate) {
  console.log(`[setTaskDatesToSprint] Updating issue ${issueKey} with startDate: ${startDate}, endDate: ${endDate}`);
  // Check if customfield_10015 is editable for this issue
  const editMetaUrl = `${JIRA_BASE}/rest/api/3/issue/${issueKey}/editmeta`;
  console.log('[setTaskDatesToSprint] Fetching editmeta:', editMetaUrl);
  const editMetaRes = await fetch(editMetaUrl, {
    headers: {
      'Authorization': `Basic ${JIRA_AUTH}`,
      'Accept': 'application/json',
    },
  });

  let updateFields = { duedate: endDate };
  if (editMetaRes.ok) {
    const editMeta = await editMetaRes.json();
    console.log('[setTaskDatesToSprint] editmeta response:', editMeta);
    if (
      editMeta.fields &&
      Object.prototype.hasOwnProperty.call(editMeta.fields, 'customfield_10015')
    ) {
      updateFields.customfield_10015 = startDate;
    }
  } else {
    const text = await editMetaRes.text();
    console.error('[setTaskDatesToSprint] Failed to fetch editmeta for customfield check:', editMetaRes.status, text);
  }

  // Update the issue
  const updateUrl = `${JIRA_BASE}/rest/api/3/issue/${issueKey}`;
  console.log('[setTaskDatesToSprint] Updating issue at:', updateUrl);
  console.log('[setTaskDatesToSprint] Payload:', JSON.stringify({ fields: updateFields }));
  const updateRes = await fetch(updateUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${JIRA_AUTH}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: updateFields }),
  });
  const updateText = await updateRes.text();
  if (!updateRes.ok) {
    console.error('[setTaskDatesToSprint] Failed to update issue:', updateRes.status, updateText);
  } else {
    console.log(`[setTaskDatesToSprint] Updated ${issueKey} with sprint start and end dates. Jira response:`, updateText);
  }
}

// =========================
// Utility: Set Subtask Assignee to Parent's Assignee
// =========================
async function setSubtaskAssigneeToParent(subtaskKey, parentKey) {
  // Get parent issue details
  const parentRes = await fetch(
    `${JIRA_BASE}/rest/api/3/issue/${parentKey}`,
    {
      headers: {
        'Authorization': `Basic ${JIRA_AUTH}`,
        'Accept': 'application/json',
      },
    }
  );
  if (!parentRes.ok) {
    console.error('Failed to fetch parent issue:', parentKey, parentRes.status, await parentRes.text());
    return;
  }
  const parentData = await parentRes.json();
  const parentAssignee = parentData.fields && parentData.fields.assignee;
  if (!parentAssignee || !parentAssignee.accountId) {
    console.log('Parent issue has no assignee to copy.');
    return;
  }

  // Set subtask assignee
  const updateRes = await fetch(
    `${JIRA_BASE}/rest/api/3/issue/${subtaskKey}/assignee`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${JIRA_AUTH}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: parentAssignee.accountId }),
    }
  );
  if (!updateRes.ok) {
    console.error('Failed to update subtask assignee:', updateRes.status, await updateRes.text());
  } else {
    console.log(`Set assignee of subtask ${subtaskKey} to match parent ${parentKey}.`);
  }
}

// =========================
// Webhook Endpoint
// =========================
app.post('/jira-webhook', async (req, res) => {
  const webhookEvent = req.body.webhookEvent;
  if (webhookEvent === 'jira:issue_created') {
    const issue = req.body.issue;
    const issueKey = issue && issue.key;
    const fields = issue && issue.fields;
    const projectKey = fields && fields.project && fields.project.key;
    const issueType = fields && fields.issuetype;

    // Existing sprint date logic (do not touch)
    if (issueKey && projectKey) {
      const boardId = await getBoardIdForProject(projectKey);
      if (boardId) {
        const { startDate, endDate } = await getCurrentSprintDates(boardId);
        if (startDate && endDate) {
          await setTaskDatesToSprint(issueKey, startDate, endDate);
        } else {
          console.log('Could not get sprint dates to update issue.');
        }
      } else {
        console.log('No board found for project:', projectKey);
      }
    }

    // New: If this is a subtask, set assignee to parent's assignee
    if (issueType && issueType.subtask && fields && fields.parent && fields.parent.key) {
      await setSubtaskAssigneeToParent(issueKey, fields.parent.key);
    }
  }
  res.sendStatus(200);
});

// =========================
// Start Server
// =========================
const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Listening for Jira webhooks on http://localhost:${PORT}/jira-webhook`);
});
