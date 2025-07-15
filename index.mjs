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
// Utility: Get Sprint Dates
// =========================
async function getSprintDates(issueKey) {
  console.log(`[getSprintDates] Checking sprint for issue: ${issueKey}`);

  const issueUrl = `${JIRA_BASE}/rest/api/2/issue/${issueKey}?fields=customfield_10020`;
  const issueRes = await fetch(issueUrl, {
    headers: {
      'Authorization': `Basic ${JIRA_AUTH}`,
      'Accept': 'application/json',
    },
  });

  if (!issueRes.ok) {
    console.error(`[getSprintDates] Failed to fetch issue ${issueKey}:`, issueRes.status, await issueRes.text());
    return {};
  }

  const issueData = await issueRes.json();
  console.log('[getSprintDates] Issue data:', issueData);
  const sprintField = issueData.fields.customfield_10020;

  if (!sprintField || sprintField.length === 0) {
    console.log(`[getSprintDates] No sprint assigned to issue ${issueKey}`);
    return {};
  }

  const latestSprint = sprintField[sprintField.length - 1];
  const sprintId = latestSprint.id;

  if (!sprintId) {
    console.log(`[getSprintDates] No sprint ID found in customfield_10020`);
    return {};
  }

  const sprintUrl = `${JIRA_BASE}/rest/agile/1.0/sprint/${sprintId}`;
  const sprintRes = await fetch(sprintUrl, {
    headers: {
      'Authorization': `Basic ${JIRA_AUTH}`,
      'Accept': 'application/json',
    },
  });

  if (!sprintRes.ok) {
    console.error(`[getSprintDates] Failed to fetch sprint ${sprintId}:`, sprintRes.status, await sprintRes.text());
    return {};
  }

  const sprintData = await sprintRes.json();
  console.log('[getSprintDates] Sprint data:', sprintData);

  const startDate = sprintData.startDate || sprintData.customfield_10015;
  const endDate = sprintData.endDate || sprintData.duedate;

  if (startDate && endDate) {
    return { startDate, endDate };
  }

  console.log(`[getSprintDates] Sprint ${sprintId} does not have start/end dates.`);
  return {};
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
  
  const issue = req.body.issue;
  const issueKey = issue && issue.key;
  const fields = issue && issue.fields;
  const changelog = req.body.changelog;

  // Issue created
  if (webhookEvent === 'jira:issue_created') {
    const issueType = fields && fields.issuetype;
    const projectKey = fields && fields.project && fields.project.key;

    if (issueType && issueType.subtask && fields && fields.parent && fields.parent.key) {
      await setSubtaskAssigneeToParent(issueKey, fields.parent.key);
    }

    if (issueKey) {
      const { startDate, endDate } = await getSprintDates(issueKey);

      if (startDate && endDate) {
        await setTaskDatesToSprint(issueKey, startDate, endDate);
      }
    }
  }
    
  if (webhookEvent === 'jira:issue_updated' && changelog && changelog.items) {
    const sprintChange = changelog.items.find(item => item.field === 'Sprint');
    console.log('[Sprint Change] Sprint change:', sprintChange);

    if (sprintChange && sprintChange.to) {
      const newSprintId = sprintChange.to;

      console.log('[Sprint Change] New sprint ID:', sprintChange.to, newSprintId);

      if (newSprintId) {
        console.log(`[Sprint Change] Detected sprint change for issue ${issueKey} → Sprint ID ${newSprintId}`);

        const sprintDetailsUrl = `${JIRA_BASE}/rest/agile/1.0/sprint/${newSprintId}`;
        const sprintRes = await fetch(sprintDetailsUrl, {
          headers: {
            'Authorization': `Basic ${JIRA_AUTH}`,
            'Accept': 'application/json',
          },
        });

        if (sprintRes.ok) {
          const sprintData = await sprintRes.json();
          const startDate = sprintData.startDate || sprintData.customfield_10015;
          const endDate = sprintData.endDate || sprintData.duedate;

          if (startDate && endDate) {
            await setTaskDatesToSprint(issueKey, startDate, endDate);
          } else {
            console.log(`[Sprint Change] No dates found in sprint ${newSprintId}`);
          }
        } else {
          console.error(`[Sprint Change] Failed to fetch sprint details for ${newSprintId}`);
        }
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
