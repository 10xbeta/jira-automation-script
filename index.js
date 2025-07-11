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
  const res = await fetch(
    `${JIRA_BASE}/rest/agile/1.0/board?projectKeyOrId=${projectKey}`,
    {
      headers: {
        'Authorization': `Basic ${JIRA_AUTH}`,
        'Accept': 'application/json',
      },
    }
  );
  if (!res.ok) {
    console.error('Failed to fetch boards for project:', projectKey, res.status, await res.text());
    return null;
  }
  const data = await res.json();
  if (data.values && data.values.length > 0) {
    return data.values[0].id; // Use the first board found
  }
  return null;
}

// =========================
// Utility: Get Current Sprint Dates for Board
// =========================
async function getCurrentSprintDates(boardId) {
  // Get active sprints for the board
  const sprintsRes = await fetch(
    `${JIRA_BASE}/rest/agile/1.0/board/${boardId}/sprint?state=active`,
    {
      headers: {
        'Authorization': `Basic ${JIRA_AUTH}`,
        'Accept': 'application/json',
      },
    }
  );
  if (!sprintsRes.ok) {
    console.error('Jira API error (sprints):', sprintsRes.status, await sprintsRes.text());
    return {};
  }
  const sprintsBody = await sprintsRes.json();
  if (!sprintsBody.values || sprintsBody.values.length === 0) {
    console.log('No active sprints found.');
    return {};
  }
  const currentSprint = sprintsBody.values[0];

  // Get full sprint details
  const sprintDetailsRes = await fetch(
    `${JIRA_BASE}/rest/agile/1.0/sprint/${currentSprint.id}`,
    {
      headers: {
        'Authorization': `Basic ${JIRA_AUTH}`,
        'Accept': 'application/json',
      },
    }
  );
  if (!sprintDetailsRes.ok) {
    console.error('Jira API error (sprint details):', sprintDetailsRes.status, await sprintDetailsRes.text());
    return {};
  }
  const sprintDetails = await sprintDetailsRes.json();
  const startDate = sprintDetails.startDate || sprintDetails.customfield_10015;
  const endDate = sprintDetails.endDate || sprintDetails.duedate;
  return { startDate, endDate };
}

// =========================
// Utility: Update Issue with Sprint Dates
// =========================
async function setTaskDatesToSprint(issueKey, startDate, endDate) {
  // Check if customfield_10015 is editable for this issue
  const editMetaRes = await fetch(
    `${JIRA_BASE}/rest/api/3/issue/${issueKey}/editmeta`,
    {
      headers: {
        'Authorization': `Basic ${JIRA_AUTH}`,
        'Accept': 'application/json',
      },
    }
  );

  let updateFields = { duedate: endDate };
  if (editMetaRes.ok) {
    const editMeta = await editMetaRes.json();
    if (
      editMeta.fields &&
      Object.prototype.hasOwnProperty.call(editMeta.fields, 'customfield_10015')
    ) {
      updateFields.customfield_10015 = startDate;
    }
  } else {
    console.error('Failed to fetch editmeta for customfield check:', editMetaRes.status, await editMetaRes.text());
  }

  // Update the issue
  const updateRes = await fetch(
    `${JIRA_BASE}/rest/api/3/issue/${issueKey}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${JIRA_AUTH}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: updateFields }),
    }
  );
  if (!updateRes.ok) {
    console.error('Failed to update issue:', updateRes.status, await updateRes.text());
  } else {
    console.log(`Updated ${issueKey} with sprint start and end dates.`);
  }
}

// =========================
// Webhook Endpoint
// =========================
app.post('/jira-webhook', async (req, res) => {
  const webhookEvent = req.body.webhookEvent;
  if (webhookEvent === 'jira:issue_created') {
    const issueKey = req.body.issue && req.body.issue.key;
    const projectKey =
      req.body.issue &&
      req.body.issue.fields &&
      req.body.issue.fields.project &&
      req.body.issue.fields.project.key;

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
