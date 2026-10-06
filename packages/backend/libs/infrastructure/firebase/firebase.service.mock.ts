export class FirebaseMockService {
  public fbAuth: {
    verifyIdToken: jest.Mock<any, any>;
  };

  constructor() {
    this.fbAuth = {
      verifyIdToken: jest.fn(),
    };

    this.createIdTokenFromEmail = jest.fn();
  }

  public async createIdTokenFromEmail(email: string) {
    // stub
  }
}
