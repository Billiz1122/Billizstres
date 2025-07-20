# **App Name**: NetRunner

## Core Features:

- Command Terminal UI: Display a terminal-like interface to accept commands and show output, emulating a cyberpunk hacking environment.
- Attack Management: Translate user commands into API calls and manage the attack queue, limiting max attack time per user to 90 seconds and max API call time to 30 seconds.  APIs are now read from a configuration file.
- Attack Execution: Initiate network attacks using user-provided host, port, time, and method, ensuring the method is within the allowed list. APIs are now read from a configuration file.
- Request Queueing: Implement queueing system for managing multiple attack requests, notifying users of their position and estimated wait time.
- Notifications & Alerts: Show status notifications and warnings in the user interface to inform them on progress, errors and current queue state.
- AI-Enhanced Command Parsing: AI Tool to parse complex instructions or website addresses in plain English, decide how to invoke multiple attacks sequentially, if appropriate, and select appropriate attack parameters and timing.

## Style Guidelines:

- Primary color: Electric Indigo (#6F00FF) to capture a futuristic, energetic feel. It stands out against the dark background.
- Background color: Dark charcoal gray (#222222), providing a stark contrast and enhancing the cyberpunk aesthetic.
- Accent color: Neon Green (#39FF14) for highlights, error messages, and active elements, contributing to the high-tech visual vibe.
- Additional Background Elements: Use subtle gradients of deep blues and purples overlaid on the charcoal gray to simulate depth and the glow of city lights reflecting off wet streets.
- Body and headline font: 'Space Grotesk', sans-serif, for both headlines and body text to provide a computerized and techy feel.
- Use minimalist, glowing icons to represent different attack methods and status indicators, enhancing the terminal-like interface.
- Implement a full-screen terminal layout with clear delineation between input and output sections, using fixed-width columns for data presentation.
- Add subtle, rapid text animations (glitching) and loading bars during attack execution to provide visual feedback and emulate a live hacking sequence.