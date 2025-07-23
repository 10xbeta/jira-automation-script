// index.js
import express from 'express';
import fetch from 'node-fetch';

import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
const sesClient = new SESClient({ region: "us-east-1" });

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
// Utility: Get Active/Future Sprint Dates for Issue
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
  const sprintField = issueData.fields.customfield_10020;

  console.log('[getSprintDates] Issue data:', issueData);

  if (!sprintField || sprintField.length === 0) {
    console.log(`[getSprintDates] No sprint assigned to issue ${issueKey}`);
    return {};
  }

  // Check active then future sprint in precedence
  for (const targetState of ['active', 'future']) {
    for (let i = sprintField.length - 1; i >= 0; i--) {
      const sprint = sprintField[i];
      const sprintId = sprint.id;

      if (!sprintId) continue;

      const sprintUrl = `${JIRA_BASE}/rest/agile/1.0/sprint/${sprintId}`;
      const sprintRes = await fetch(sprintUrl, {
        headers: {
          'Authorization': `Basic ${JIRA_AUTH}`,
          'Accept': 'application/json',
        },
      });

      if (!sprintRes.ok) {
        console.error(`[getSprintDates] Failed to fetch sprint ${sprintId}:`, sprintRes.status, await sprintRes.text());
        continue;
      }

      const sprintData = await sprintRes.json();
      console.log('[getSprintDates] Sprint data:', sprintData);

      if (sprintData.state?.toLowerCase() === targetState) {
        const startDate = sprintData.startDate || sprintData.customfield_10015;
        const endDate = sprintData.endDate || sprintData.duedate;

        if (startDate && endDate) {
          return { startDate, endDate };
        }
      }
    }
  }

  console.log(`[getSprintDates] No active or future sprint with valid dates found.`);
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
// Email Notification
// =========================
async function sendEmailNotification({ issueKey, trigger, description }) {
  console.log("[Email] Sending notification...", trigger, issueKey, description);
  const recipients = (process.env.USER_EMAILS_FOR_NOTIFICATIONS || "").split(",").map(email => email.trim()).filter(Boolean);

  console.log("[Email] Recipients:", recipients);

  if (recipients.length === 0) {
    console.log("[Email] No recipients configured. Skipping email notification.");
    return;
  }
  
  const params = {
    Destination: {
      ToAddresses: recipients
    },
    Message: {
      Body: {
        Text: {
          Data: `Issue: ${issueKey}\nTrigger: ${trigger}\nAction: ${description}`,
        },
      },
      Subject: {
        Data: `Jira Automation Triggered for ${issueKey}`,
      },
    },
    Source: process.env.SOURCE_EMAIL,
  };

  console.log("[Email] Sending email with params:", params);

  try {
    const result = await sesClient.send(new SendEmailCommand(params));
    console.log("[Email] Sent notification:", result.MessageId);
  } catch (err) {
    console.error("[Email] Failed to send notification:", err);
  }
}

// =========================
// Slack Notification
// =========================
async function sendSlackNotification({ issueKey, trigger, description }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const issueUrl = `https://10xbeta.atlassian.net/browse/${issueKey}`;
  if (!webhookUrl) {
    console.log("[Slack] No webhook URL configured. Skipping notification.");
    return;
  }

  const payload = {
    text: `AWS-Jira Automation Triggered for <${issueUrl}|${issueKey}>`,
    attachments: [
      {
        color: "#2c2d30",
        fields: [
          { title: "• Trigger", value: trigger, short: true },
          { title: "• Action", value: description, short: false },
        ],
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Slack] Failed to send message: ${res.status} ${text}`);
    } else {
      console.log(`[Slack] Sent message for ${issueKey}`);
    }
  } catch (err) {
    console.error('[Slack] Error sending message:', err);
  }
}

// =========================
// Webhook Endpoint & Lambda Handler
// =========================
app.post('/jira-webhook', async (req, res) => {
  const webhookEvent = req.body.webhookEvent;
  
  const issue = req.body.issue;
  const issueKey = issue && issue.key;
  const fields = issue && issue.fields;
  const changelog = req.body.changelog;

  const issueType = fields && fields.issuetype;
  const projectKey = fields && fields.project && fields.project.key;
  
  let description = "";

  // Issue created
  if (webhookEvent === 'jira:issue_created') {
    description = `An issue (${issueKey}) was created on Jira.`;

    if (issueType && issueType.subtask && fields && fields.parent && fields.parent.key) {
      await setSubtaskAssigneeToParent(issueKey, fields.parent.key);

      description += `\n\nThis script updated subtask assignee from its parent (${fields.parent.key})`;
    }

    if (issueKey) {
      const { startDate, endDate } = await getSprintDates(issueKey);

      if (startDate && endDate) {
        await setTaskDatesToSprint(issueKey, startDate, endDate);
        
        const formattedStart = new Date(startDate).toISOString().slice(0, 10);
        const formattedEnd = new Date(endDate).toISOString().slice(0, 10);
        description += `\n\nThis script updated start (${formattedStart}) & due (${formattedEnd}) dates for the issue (based on assigned sprint).\n`;
      }
    }

    await sendNotificationEmail({
      issueKey,
      trigger: "jira:issue_created \n",
      description
    });
  }
    
  if (webhookEvent === 'jira:issue_updated' && changelog && changelog.items) {
    const sprintChange = changelog.items.find(item => item.field === 'Sprint');
    console.log('[Sprint Change] Sprint change:', sprintChange);

    if (sprintChange && sprintChange.to) {
      console.log('[Sprint Change] New sprint ID:', sprintChange.to);
      description = `Sprint was updated for issue ${issueKey} on Jira.`;

      if (issueKey) {
        const { startDate, endDate } = await getSprintDates(issueKey);

        if (startDate && endDate) {
          await setTaskDatesToSprint(issueKey, startDate, endDate);
          
          const formattedStart = new Date(startDate).toISOString().slice(0, 10);
          const formattedEnd = new Date(endDate).toISOString().slice(0, 10);
          description += `\n\nThis script updated start (${formattedStart}) & due (${formattedEnd}) dates for the issue (based on assigned sprint).\n`;
        }
      }

      await sendNotificationEmail({
        issueKey,
        trigger: "jira:issue_updated \n",
        description
      });
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
