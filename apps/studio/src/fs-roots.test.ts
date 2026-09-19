// @vitest-environment node
/**
 * W885 follow-up — the fs-browse shortcuts are a PLATFORM question.
 *
 * The roots used to be the POSIX constant ["/src","/tmp","/srv","/home"], so a
 * Windows user's directory picker offered four directories that cannot exist, and
 * the same list supplies the default path when a client sends none. `platform`
 * and `env` are injectable, so the win32 answer is asserted on this Linux host.
 */
import { describe, expect, it } from 'vitest';
import { fsRoots } from './config.js';

describe('fsRoots', () => {
  it('POSIX: byte-identical to the old constant', () => {
    expect(fsRoots('linux', {})).toEqual(['/src', '/tmp', '/srv', '/home']);
    expect(fsRoots('darwin', {})).toEqual(['/src', '/tmp', '/srv', '/home']);
  });

  it('win32: the system drive and the user profile, never the POSIX four', () => {
    const roots = fsRoots('win32', { SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\me' });
    expect(roots).toEqual(['C:\\', 'C:\\Users\\me']);
    expect(roots).not.toContain('/src');
  });

  it('win32: tolerates a missing SystemDrive/USERPROFILE and trailing separators', () => {
    expect(fsRoots('win32', {})).toEqual(['C:\\']);
    expect(fsRoots('win32', { SystemDrive: 'D:\\', USERPROFILE: 'D:\\Users\\me\\' })).toEqual(['D:\\', 'D:\\Users\\me']);
  });

  it('win32: the first root is a usable default path', () => {
    expect(fsRoots('win32', { SystemDrive: 'C:' })[0]).toBe('C:\\');
  });
});
