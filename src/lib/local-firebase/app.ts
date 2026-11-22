export interface FirebaseApp {
  name: string;
  options: Record<string, any>;
}

const defaultApp: FirebaseApp = {
  name: '[DEFAULT]',
  options: {},
};

export function initializeApp(config: Record<string, any> = {}, name = '[DEFAULT]'): FirebaseApp {
  return {
    name,
    options: config,
  };
}

export function getApp(): FirebaseApp {
  return defaultApp;
}

export function getApps(): FirebaseApp[] {
  return [defaultApp];
}
