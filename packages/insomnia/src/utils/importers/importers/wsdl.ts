import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  findWSDLForServiceName,
  getJsonForWSDL,
  getSwaggerForService,
  getWSDLServices,
  type Swagger,
} from 'apiconnect-wsdl';

import type { Converter } from '../entities';
import * as postman from './postman';

export const id = 'wsdl';
export const name = 'WSDL';
export const description = 'Importer for WSDL files';

const pathToSwagger = (swagger: any, path: string[]) => {
  return path.reduce((acc, v: string) => {
    try {
      acc = acc[v];
    } catch (e) {
      return undefined;
    }
    return acc;
  }, swagger);
};

const convertToPostman = (items: Swagger[]) => {
  const item = items.map(swagger => {
    const item = [];
    const url = swagger['x-ibm-configuration'].assembly.execute[0].proxy['target-url'];

    for (const path of Object.keys(swagger.paths)) {
      const methods = swagger.paths[path];

      for (const method of Object.keys(methods)) {
        const api = methods[method];
        const paths = api.parameters[0].schema.$ref.split('/');
        paths.shift();
        paths.push('example');
        const example = pathToSwagger(swagger, paths);
        item.push({
          name: api.operationId,
          description: api.description || '',
          request: {
            url,
            method,
            header: [
              {
                key: 'SOAPAction',
                value: api['x-ibm-soap']['soap-action'],
              },
              {
                key: 'Content-Type',
                value: swagger.consumes[0],
              },
              {
                key: 'Accept',
                value: swagger.produces[0],
              },
            ],
            body: {
              mode: 'raw',
              raw: example,
            },
          },
        });
      }
    }

    return {
      name: swagger.info.title,
      item,
    };
  });
  return {
    info: {
      name: items[0].info.title,
      schema: 'https://schema.getpostman.com/json/collection/v2.0.0/', // required
    },
    item,
  };
};

const convertWsdlToPostman = async (input: string) => {
  const wsdls = await getJsonForWSDL(input);
  const { services } = getWSDLServices(wsdls);

  const items = services.map(({ service, filename }: { service: string; filename: string }) => {
    const wsdlEntry = findWSDLForServiceName(wsdls, service);
    return getSwaggerForService(wsdlEntry, service, filename);
  });

  return convertToPostman(items);
};

export const convert: Converter = async rawData => {
  try {
    if (!verifyWsdl(rawData)) {
      return null;
    }
    const postmanData = await convertWsdlToPostman(
      `<?xml version="1.0" encoding="UTF-8" ?>${rawData}`,
    );
    postmanData.info.schema += 'collection.json';
    const postmanJson = JSON.stringify(postmanData);
    return postman.convert(postmanJson);
  } catch (error) {
    console.error(error);
    // Nothing
  }

  return null;
};

const xmlSchemaNamespaceUri = 'http://www.w3.org/2001/XMLSchema';
const wsdlNamespaceUri = 'http://schemas.xmlsoap.org/wsdl/';

function verifyWsdl(fileContent: string) {
  try {
    const mainWsdlDocument = new DOMParser().parseFromString(fileContent, 'text/xml');
    return mainWsdlDocument.documentElement.namespaceURI === wsdlNamespaceUri &&
      mainWsdlDocument.documentElement.localName === 'definitions';
  } catch (error) {
    return false;
  }
}

function isXmlSchemaElement(element: Element) {
  return element.namespaceURI === xmlSchemaNamespaceUri && element.localName === 'schema';
}

async function recurseXmlSchema(xsdFilePath: string, onTrackSet: Set<string>, needToVerifyXmlSchema = true) {
  if (onTrackSet.has(xsdFilePath)) {
    return null;
  }
  const fileContent = await readFile(xsdFilePath, 'utf-8');
  const xsdDocument = new DOMParser().parseFromString(fileContent, 'text/xml');
  if (needToVerifyXmlSchema) {
    if (
      !isXmlSchemaElement(xsdDocument.documentElement)
    ) {
      return null;
    }
  }

  onTrackSet.add(xsdFilePath);

  try {
    // find all import and include tags
    const referenceElements = [
      ...Array.from(xsdDocument.getElementsByTagNameNS(xmlSchemaNamespaceUri, 'import')),
      ...Array.from(xsdDocument.getElementsByTagNameNS(xmlSchemaNamespaceUri, 'include')),
    ];
    if (referenceElements.length === 0) {
      onTrackSet.delete(xsdFilePath);
      return xsdDocument.documentElement;
    } else {
      for (const referenceElement of referenceElements) {
        const schemaLocation = referenceElement.getAttribute('schemaLocation');
        if (!schemaLocation) {
          continue;
        }
        // only handle relative paths that exist
        const absolutePath = path.resolve(path.dirname(xsdFilePath), schemaLocation);
        try {
          // assure that the file exists
          await readFile(absolutePath, 'utf-8');
          const childElement = await recurseXmlSchema(absolutePath, onTrackSet);
          if (!childElement) {
            continue;
          }
          const parentElementOfReferenceElement = referenceElement.parentNode;
          parentElementOfReferenceElement?.replaceChild(childElement, referenceElement);
          // remove nested schema element
          if (parentElementOfReferenceElement && isXmlSchemaElement(parentElementOfReferenceElement as Element)) {
            parentElementOfReferenceElement.parentNode?.replaceChild(childElement, parentElementOfReferenceElement);
          }
        } catch (error) {
          continue;
        }
      }
      onTrackSet.delete(xsdFilePath);
      return xsdDocument.documentElement;
    }
  } catch (error) {
    onTrackSet.delete(xsdFilePath);
    return null;
  }
}

// Merge all referenced xml schema files into the main wsdl file
export async function flattenWsdl(mainFileContent: string, mainFilePath: string) {
  if (!verifyWsdl(mainFileContent)) {
    throw new Error('Invalid WSDL file');
  }

  // keep track of all on track filepaths to avoid circular references
  const onTrackSet = new Set<string>();

  const documentElement = await recurseXmlSchema(mainFilePath, onTrackSet, false);

  if (documentElement && documentElement.ownerDocument) {
    return new XMLSerializer().serializeToString(documentElement.ownerDocument);
  } else {
    throw new Error('Cannot flatten WSDL');
  }
}
