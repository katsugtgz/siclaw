import {it,expect} from 'vitest';
import {resolveCodexMemoryEnabled} from './codex-memory.js';
it('preserves legacy native defaults and requires exact boolean toggles',()=>{
 for(const value of [undefined,null,true])expect(resolveCodexMemoryEnabled(value)).toBe(true);
 expect(resolveCodexMemoryEnabled(false)).toBe(false);
 for(const value of ['false',0,{},[]])expect(()=>resolveCodexMemoryEnabled(value)).toThrow();
});
