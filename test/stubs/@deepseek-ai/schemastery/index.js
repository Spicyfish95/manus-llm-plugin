// Stub of @deepseek-ai/schemastery for offline import testing.
const chain = () => {
	const api = {
		default: (v) => (api._default = v, api),
		role: () => api,
		volatile: () => api,
		required: () => api,
		min: () => api,
		max: () => api,
		step: () => api,
		get: () => api
	};
	return api;
};
const z = (type) => chain();
z.object = () => chain();
z.string = () => chain();
z.number = () => chain();
z.boolean = () => chain();
z.const = () => chain();
z.union = () => chain();
z.array = () => chain();
export default z;
