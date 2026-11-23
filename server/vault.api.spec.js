import mongoose from 'mongoose';
import supertest from 'supertest';
import createApp from './app.js';
import { model as HomebrewModel } from './homebrew.model.js';

let app;
let request;
let dbState;

beforeAll(async ()=>{
	app = await createApp();
	request = supertest.agent(app).set('X-Forwarded-Proto', 'https');
});

// Returns the author condition from the query the Vault sent to the database
const authorCondition = (query)=>query.$and.find((condition)=>condition.authors)?.authors;

// Whether a brew with these authors would match, following MongoDB's $elemMatch rules
const matchesAuthors = (condition, authors)=>{
	const { $regex, $options, $not } = condition.$elemMatch;
	const regex = new RegExp($regex, $options);
	return authors.some((author)=>regex.test(author) && !$not.test(author));
};

describe('Vault author search', ()=>{
	let findQuery;
	let countQuery;

	beforeEach(()=>{
		dbState = mongoose.connection.readyState;
		mongoose.connection.readyState = 1;
		findQuery = undefined;
		countQuery = undefined;

		jest.spyOn(HomebrewModel, 'find').mockImplementation((query)=>{
			findQuery = query;
			const chain = {
				sort      : ()=>chain,
				skip      : ()=>chain,
				limit     : ()=>chain,
				maxTimeMS : ()=>chain,
				exec      : ()=>Promise.resolve([])
			};
			return chain;
		});
		jest.spyOn(HomebrewModel, 'countDocuments').mockImplementation((query)=>{
			countQuery = query;
			return { maxTimeMS: ()=>Promise.resolve(0) };
		});
	});

	afterEach(()=>{
		mongoose.connection.readyState = dbState;
		jest.restoreAllMocks();
	});

	afterAll(async ()=>{
		await mongoose.connection.close();
	});

	const search = async (author)=>{
		const response = await request.get('/api/vault').query({ title: '', author, v3: true, legacy: true });
		expect(response.statusCode).toBe(200);
		return authorCondition(findQuery);
	};

	it('adds no author condition when no author is given', async ()=>{
		expect(await search('')).toBeUndefined();
	});

	it('ignores case', async ()=>{
		const condition = await search('gazook89');
		expect(matchesAuthors(condition, ['Gazook89'])).toBe(true);
		expect(matchesAuthors(condition, ['GAZOOK89'])).toBe(true);
	});

	it('matches part of a name from three characters', async ()=>{
		const condition = await search('Gaz');
		expect(matchesAuthors(condition, ['Gazook89'])).toBe(true);
		expect(matchesAuthors(condition, ['someone', 'MegaZord'])).toBe(true);
		expect(matchesAuthors(condition, ['calculuschild'])).toBe(false);
	});

	it('matches any of the brew\'s authors', async ()=>{
		const condition = await search('cleric');
		expect(matchesAuthors(condition, ['calculuschild', '5e-Cleric'])).toBe(true);
	});

	it('needs the whole name for searches under three characters', async ()=>{
		const condition = await search('ab');
		expect(matchesAuthors(condition, ['AB'])).toBe(true);
		expect(matchesAuthors(condition, ['abc', 'Kabal'])).toBe(false);
	});

	it('treats regular expression characters as plain text', async ()=>{
		expect(matchesAuthors(await search('a.c'), ['abc'])).toBe(false);
		expect(matchesAuthors(await search('a.c'), ['a.c'])).toBe(true);
		expect(matchesAuthors(await search('(a+)+$'), ['aaaa'])).toBe(false);
		expect(matchesAuthors(await search('.*'), ['anyone'])).toBe(false);
	});

	it('never matches authors stored as email addresses', async ()=>{
		expect(matchesAuthors(await search('gmail'), ['someone@gmail.com'])).toBe(false);
		expect(matchesAuthors(await search('someone'), ['someone@gmail.com'])).toBe(false);
		expect(matchesAuthors(await search('someone'), ['someone@gmail.com', 'someone_else'])).toBe(true);
	});

	it('ignores an author parameter that is not a single string', async ()=>{
		const response = await request.get('/api/vault?title=&author=a&author=b&v3=true&legacy=true');
		expect(response.statusCode).toBe(200);
		expect(authorCondition(findQuery)).toBeUndefined();
	});

	it('uses the same author condition for the total count', async ()=>{
		const condition = await search('Gaz');
		await request.get('/api/vault/total').query({ title: '', author: 'Gaz', v3: true, legacy: true });
		expect(authorCondition(countQuery)).toEqual(condition);
	});
});
