import dotenv from 'dotenv';
import { fromEnv } from './src/api.js';

dotenv.config();

async function run() {
  try {
    const parentCommentId = "4741792070";
    const pageId = "4741532409";
    
    // Create a reply comment
    const createRes = await fetch(`${process.env.CONFLUENCE_URL}/rest/api/content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(process.env.CONFLUENCE_EMAIL + ':' + process.env.CONFLUENCE_API_TOKEN).toString('base64')}`
      },
      body: JSON.stringify({
        type: 'comment',
        container: { id: pageId, type: 'page' },
        ancestors: [{ id: parentCommentId }],
        body: {
          storage: {
            value: '<p>This is a test nested comment reply.</p>',
            representation: 'storage'
          }
        }
      })
    });
    console.log('Created reply:', await createRes.text());
  } catch(e) {
    console.error(e);
  }
}
run();