/** which tool the scene view's gizmo shows: move (arrows), rotate (rings) or scale (one handle). not persisted. */
import { create } from 'zustand';
import type { SceneTool } from './sceneGizmo';
import { parseGridOn } from './sceneHelpers';

interface SceneToolState {
  tool: SceneTool;
  setTool(tool: SceneTool): void;
}

export const useSceneTool = create<SceneToolState>()((set) => ({
  tool: 'move',
  setTool(tool) {
    set({ tool });
  },
}));

/** keys of the tools, only while the scene view has the keyboard focus (r and e are global shortcuts elsewhere) */
export const TOOL_KEYS: Readonly<Record<string, SceneTool>> = { w: 'move', e: 'rotate', r: 'scale' };

const GRID_KEY = 'ncut.scene.grid';

function loadGrid(): boolean {
  try {
    return parseGridOn(localStorage.getItem(GRID_KEY));
  } catch {
    return true;
  }
}

interface SceneGridState {
  on: boolean;
  toggle(): void;
}

/** the floor grid and world axis lines of the scene view: on / off, remembered in localStorage (it can be blocked) */
export const useSceneGrid = create<SceneGridState>((set, get) => ({
  on: loadGrid(),
  toggle() {
    const on = !get().on;
    try {
      localStorage.setItem(GRID_KEY, on ? '1' : '0');
    } catch {
      // storage is blocked: the choice still works for this session
    }
    set({ on });
  },
}));
