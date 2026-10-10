/**
 * Handles the ping request.
 * @param _msg - The ping request message.
 * @returns A resolved promise with the pong response.
 */
import { Buffer } from 'buffer';

export function pingHandler(_msg: any): Promise<Buffer> {
  return Promise.resolve(Buffer.from('pong'));
}
