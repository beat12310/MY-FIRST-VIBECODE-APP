'use client';

import { useState } from 'react';

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState('');

  const generateApp = () => {
    setResult(`
Project Request:

${prompt}

Status:
✅ Request received.

Next Step:
Connect this interface to an AI model (OpenAI, Claude, AWS Bedrock, etc.) so it can generate websites and apps automatically.
    `);
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0f172a',
        color: 'white',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '20px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '900px',
          background: '#1e293b',
          padding: '30px',
          borderRadius: '20px',
        }}
      >
        <h1
          style={{
            fontSize: '40px',
            marginBottom: '10px',
            textAlign: 'center',
          }}
        >
          Bright VibeCode AI
        </h1>

        <p
          style={{
            textAlign: 'center',
            marginBottom: '20px',
          }}
        >
          Describe the website or app you want to build.
        </p>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Example: Build me a hotel booking app with online payments and admin dashboard"
          style={{
            width: '100%',
            height: '200px',
            padding: '15px',
            borderRadius: '10px',
            fontSize: '16px',
          }}
        />

        <button
          onClick={generateApp}
          style={{
            marginTop: '20px',
            width: '100%',
            padding: '15px',
            fontSize: '18px',
            background: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: '10px',
            cursor: 'pointer',
          }}
        >
          Generate App
        </button>

        {result && (
          <div
            style={{
              marginTop: '20px',
              background: '#334155',
              padding: '20px',
              borderRadius: '10px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {result}
          </div>
        )}
      </div>
    </main>
  );
}
