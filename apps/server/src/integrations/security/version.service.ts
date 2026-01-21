import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('./../../../package.json');

@Injectable()
export class VersionService {
  constructor() {}

  async getVersion() {
    let latestVersion = 0;
    try {
      const response = await fetch('');
      if (!response.ok) return;
      const data = await response.json();
      latestVersion = data?.tag_name?.replace('v', '');
    } catch (err) {
      /* empty */
    }

    return {
      currentVersion: packageJson?.version,
      latestVersion: latestVersion,
      releaseUrl: '',
    };
  }
}
