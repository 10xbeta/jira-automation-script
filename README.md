# Jira-AWS Automation Script

This AWS Lambda-based script automates routine Jira task maintenance and posts updates to Slack for visibility.

## Features

- Automatically assigns the **default assignee for subtasks** based on their parent issue.
- Updates **start and due dates** of Jira tasks based on their associated sprint if those fields are empty.
- Sends a **Slack notification** for every automated update performed.

## Deployment

This script is deployed to:

- **AWS Lambda** — [View Lambda Function](https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1#/functions/jiraAutomations?subtab=envVars&tab=code)  
- **API Gateway** — [View API Gateway Endpoint](https://us-east-1.console.aws.amazon.com/apigateway/main/develop/routes?api=fog8kksd6h&region=us-east-1)
- **Slack App** — [View Slack App Configuration](https://10xbeta.slack.com/marketplace/A097F9Z5REU-jira-automation-notifier?settings=1&tab=settings)

It is triggered by a **Jira Webhook** named `Jira<>AWS Automation`. The webhook sends `POST` events to the endpoint `/jira-webhook`.

## Environment Configuration

Create a `.env` file with the following variables:

```env
JIRA_USER_ID=your-jira-email@example.com
JIRA_ACCESS_TOKEN=your-jira-api-token

SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

SOURCE_EMAIL=verified-email@yourdomain.com
USER_EMAILS_FOR_NOTIFICATIONS=jane@example.com,bob@example.com
```