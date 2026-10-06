import { Injectable } from '@nestjs/common';
import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from 'axios';

/**
 * @description
 *    - this module is a super minimalistic wrapper around axios for easier mocking and to abstrac out axios
 *      in case we will use different http package in the future
 *
 */
@Injectable()
export class RequestService {
  private readonly axiosClient: AxiosInstance;

  constructor() {
    this.axiosClient = this.getRequestProcessor();
  }

  private getRequestProcessor(): AxiosInstance {
    const axiosConfig: AxiosRequestConfig = {};

    const client: AxiosInstance = axios.create(axiosConfig);

    client.interceptors.response.use(
      function (response) {
        // Do something with response data
        return response;
      },
      function (error) {
        if (error instanceof AxiosError) {
          if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            return Promise.reject({
              data: error.response.data,
              status: error.response.status,
              headers: error.response.headers,
            });
          } else if (error.request) {
            // The request was made but no response was received
            // `error.request` is an instance of XMLHttpRequest in the browser
            // and an instance of http.ClientRequest in node.js

            // Do not leak headers and other fields in error by default
            return Promise.reject({
              config: {
                baseURL: error?.config?.baseURL,
                method: error?.config?.method,
                url: error?.config?.url,
              },
              code: error.code,
              message: error.message,
              stack: error.stack,
              name: error.name,
            });
          } else {
            // Something happened in setting up the request that triggered an Error
            return Promise.reject('Error' + error.message);
          }
        }

        // Do something with response error
        return Promise.reject(error);
      },
    );

    return client;
  }

  public async request<T = any, R = AxiosResponse<T>, D = any>(
    config: AxiosRequestConfig<D>,
  ): Promise<R> {
    return this.axiosClient.request<T, R, D>(config) as any as Promise<R>;
  }
}
