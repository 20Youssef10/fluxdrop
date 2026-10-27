# Contributing to FluxDrop

Thank you for your interest in contributing to FluxDrop! This document covers the development setup, coding standards, and contribution workflow.

## Development Setup

### Prerequisites
- [Bun](https://bun.sh/) 1.0+ (recommended) or Node.js 18+
- A modern browser (Chrome 90+, Firefox 90+, Safari 15+)

### Getting Started

```bash
# Clone
git clone https://github.com/20Youssef10/fluxdrop.git
cd fluxdrop

# Install dependencies
bun install

# Install signaling server dependencies
cd mini-services/signaling && bun install && cd ../..

# Start the signaling server (port 3003)
cd mini-services/signaling && bun run dev

# In another terminal, start the Next.js app (port 3000)
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Coding Standards

### TypeScript
- Strict typing throughout
- Prefer `interface` over `type` for object shapes
- Use `const` assertions for literal types
- Avoid `any` — use `unknown` + type narrowing

### React
- Use `'use client'` for client components
- Prefer hooks over class components
- Wrap async callbacks in `try/catch` with user-facing error messages
- Use `useRef` for values accessed in long-lived callbacks to avoid stale closures

### Styling
- Use Tailwind CSS utility classes
- shadcn/ui components preferred over custom implementations
- Color palette: emerald/teal/cyan (`flux-*` CSS variables)
- **No indigo or blue** as primary colors
- Glassmorphism: `flux-glass` class
- Hover effects: `flux-hover-border` class

### State Management
- Zustand for client state (`src/stores/`)
- Keep stores focused: session state vs. transfer state
- Use refs in hooks to avoid stale closures in long-lived callbacks

### Performance
- Wrap expensive components in `React.memo`
- Use `useMemo` for expensive computations
- Yield to the event loop during long operations (hashing, chunking)
- Avoid per-allocation of `TextEncoder`/`TextDecoder` — hoist to module scope

### Error Handling
- All async functions must have top-level `try/catch`
- Surface errors as toast notifications with descriptions
- Log errors via `console.warn` for diagnostics
- Filter benign errors (ICE candidate failures, cleanup aborts) from toasts

### Linting

```bash
# Run ESLint
bun run lint
```

All code must pass lint with 0 errors and 0 warnings.

## Contribution Workflow

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feature/your-feature`
3. **Commit**: `git commit -m 'Add your feature'`
4. **Push**: `git push origin feature/your-feature`
5. **Open a Pull Request**

### Commit Messages
- Use the imperative mood: "Add feature" not "Added feature"
- Keep the first line under 72 characters
- Reference issues: "Fix #123: description"

## Project Structure

See the [README](../README.md#project-structure) for the full directory layout.

## Testing

Currently, FluxDrop relies on manual testing via the browser. To test:

1. Start both servers (signaling + Next.js)
2. Open the app in two browser tabs/windows
3. Send files from one tab and receive in the other
4. Verify the transfer completes and checksums match

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
